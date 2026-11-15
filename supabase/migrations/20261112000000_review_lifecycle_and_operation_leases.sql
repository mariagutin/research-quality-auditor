-- Migration: review lifecycle, operation leases, and concurrency-safe functions
-- Created: 2026-11-12
--
-- DATABASE-ONLY foundation for safe concurrent uploads, checks, and deletions.
-- The Storage upload policy that ties a PUT to the current attempt token, and the
-- real upload paths, are a SEPARATE migration (and app work). Until those are in
-- place AND tested, Storage protection is NOT complete -- this migration does not
-- by itself stop a late or stray file from landing in Storage.
--
-- Model
-- -----
--   * Review-row-first: a review exists (status `uploading`) BEFORE any file is
--     sent, so every legitimate file has an owning review row.
--   * Per-attempt lease: `op_token` identifies the current attempt AND fences its
--     writes; `op_heartbeat_at` is the last recorded activity (database time);
--     `op_failed_at` marks a CONFIRMED failure so recovery need not await timeout.
--   * ACTIVE vs RECOVERABLE: an operation is ACTIVE while
--       op_failed_at IS NULL AND op_heartbeat_at > now() - STALE_AFTER.
--     It is RECOVERABLE once op_failed_at IS set OR it is stale. STALE_AFTER is
--     two minutes of NO recorded activity (a heartbeat), judged with now() here in
--     the database -- never a client clock. A timeout only makes a review eligible
--     for takeover; it NEVER marks a review `complete`.
--   * Fencing: finish_upload / record_quotation_results / finalize_review_deletion
--     all require (op_token = token AND op_failed_at IS NULL AND expected status)
--     on the locked row, so a superseded or confirmed-failed attempt that wakes up
--     late writes nothing and changes no status.
--
-- Cleanup bookkeeping (folders are swept by the app via the Storage API; these are
-- the DURABLE pointers that say what still needs sweeping):
--   * review_dead_upload_attempts: one fixed-target reminder per RETIRED upload
--     attempt token (its folder {uid}/{reviewId}/{token}/). Inserted ONLY by
--     retry_upload, atomically when the old token is retired, so the live op_token
--     is never a member. A reminder is reused for later checks and is NOT retired
--     here on an empty folder or a timeout (retirement is deferred by decision).
--   * review_file_cleanups: a whole-prefix record that OUTLIVES a deleted review
--     row, so files (including late arrivals) always have a durable owner. Created
--     atomically with the review-row delete in finalize_review_deletion; a BEFORE
--     DELETE guard forbids deleting a review without it.
--
-- NOTE: create_review_with_documents() is intentionally KEPT for now (the current
-- app still calls it); finish_upload() supersedes it and the app will switch over
-- with the upload-path changes, at which point the old function is retired.
--
-- Local/disposable Supabase only until explicitly authorized for hosted.

-- ---------------------------------------------------------------------------
-- 1. Status value + lease columns on reviews.
-- ---------------------------------------------------------------------------
alter table public.reviews
  drop constraint reviews_processing_status_check;

alter table public.reviews
  add constraint reviews_processing_status_check
  check (processing_status in
    ('draft', 'uploading', 'processing', 'complete', 'failed', 'deleting'));

alter table public.reviews
  add column op_token uuid,
  add column op_heartbeat_at timestamptz,
  add column op_failed_at timestamptz;

comment on column public.reviews.op_token is
  'Current operation lease / attempt id. Writes are fenced on it; for uploads it is also the Storage path segment {uid}/{reviewId}/{op_token}/. NULL when settled.';
comment on column public.reviews.op_heartbeat_at is
  'Last recorded activity for the current operation (database time). Staleness = now() - op_heartbeat_at > 2 minutes.';
comment on column public.reviews.op_failed_at is
  'Set when the current upload/deletion attempt is CONFIRMED failed, so recovery need not wait for the staleness timeout. Reset to NULL when a new attempt begins.';

-- ---------------------------------------------------------------------------
-- 2. Durable cleanup bookkeeping tables (owner-only RLS).
-- ---------------------------------------------------------------------------

-- One fixed-target reminder per retired upload attempt folder.
create table public.review_dead_upload_attempts (
  review_id uuid not null,
  user_id uuid not null,
  token uuid not null,
  created_at timestamptz not null default now(),
  primary key (review_id, token),
  constraint review_dead_upload_attempts_review_fk
    foreign key (review_id, user_id)
    references public.reviews (id, user_id) on delete cascade
);
create index review_dead_upload_attempts_user_id_idx
  on public.review_dead_upload_attempts (user_id);

alter table public.review_dead_upload_attempts enable row level security;
create policy review_dead_upload_attempts_owner_all
  on public.review_dead_upload_attempts
  for all to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.reviews r
      where r.id = review_dead_upload_attempts.review_id
        and r.user_id = auth.uid()
    )
  );

-- Whole-prefix cleanup record that survives the review row (NO FK to reviews).
create table public.review_file_cleanups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  review_id uuid not null,
  prefix text not null,
  finalized_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint review_file_cleanups_user_prefix_key unique (user_id, prefix)
);
create index review_file_cleanups_user_id_idx on public.review_file_cleanups (user_id);

alter table public.review_file_cleanups enable row level security;
create policy review_file_cleanups_owner_all
  on public.review_file_cleanups
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 3. begin_upload: create the review as `uploading` BEFORE any file is sent.
-- ---------------------------------------------------------------------------
create function public.begin_upload(p_name text)
returns table (review_id uuid, op_token uuid)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_id uuid := gen_random_uuid();
  v_token uuid := gen_random_uuid();
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  insert into public.reviews
    (id, user_id, name, processing_status, op_token, op_heartbeat_at, op_failed_at)
  values
    (v_id, v_user_id, p_name, 'uploading', v_token, now(), null);
  review_id := v_id;
  op_token := v_token;
  return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. retry_upload: SOLE writer of dead-attempt reminders. Only from a RECOVERABLE
--    uploading review. Retires the old token (fixed-target reminder) and stamps a
--    fresh one, atomically -- so the live token is never a dead token.
-- ---------------------------------------------------------------------------
create function public.retry_upload(p_review_id uuid)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_status text;
  v_old_token uuid;
  v_heartbeat timestamptz;
  v_failed timestamptz;
  v_new_token uuid := gen_random_uuid();
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select processing_status, op_token, op_heartbeat_at, op_failed_at
    into v_status, v_old_token, v_heartbeat, v_failed
  from public.reviews
  where id = p_review_id and user_id = v_user_id
  for update;

  if not found then
    raise exception 'review not found' using errcode = 'P0002';
  end if;
  if v_status <> 'uploading' then
    raise exception 'not an uploading review (status=%)', v_status using errcode = 'P0001';
  end if;
  -- RECOVERABLE only: confirmed failed OR stale (no activity for the stale window).
  if v_failed is null
     and v_heartbeat is not null
     and v_heartbeat > now() - interval '2 minutes' then
    raise exception 'upload is still active; retry not allowed' using errcode = 'P0001';
  end if;

  -- Fixed-target reminder for the retired attempt folder, recorded BEFORE re-stamp.
  if v_old_token is not null then
    insert into public.review_dead_upload_attempts (review_id, user_id, token)
    values (p_review_id, v_user_id, v_old_token)
    on conflict (review_id, token) do nothing;
  end if;

  update public.reviews
     set op_token = v_new_token,
         op_heartbeat_at = now(),
         op_failed_at = null
   where id = p_review_id;

  return v_new_token;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. touch_review_op: refresh activity. Token-fenced AND op_failed_at-fenced, so
--    an obsolete or confirmed-failed attempt CANNOT renew the current lease.
-- ---------------------------------------------------------------------------
create function public.touch_review_op(p_review_id uuid, p_token uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_updated int;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  update public.reviews
     set op_heartbeat_at = now()
   where id = p_review_id
     and user_id = v_user_id
     and op_token = p_token
     and op_failed_at is null
     and processing_status in ('uploading', 'processing', 'deleting');
  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. fail_review_op: record a CONFIRMED failure, token-fenced.
--    processing -> `failed` (terminal, retryable); uploading/deleting -> set
--    op_failed_at (so recovery is immediate, without waiting for staleness).
-- ---------------------------------------------------------------------------
create function public.fail_review_op(p_review_id uuid, p_token uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_status text;
  v_token uuid;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select processing_status, op_token into v_status, v_token
  from public.reviews
  where id = p_review_id and user_id = v_user_id
  for update;

  if not found then
    return false;
  end if;
  -- Only the current attempt may mark itself failed, and only while busy.
  if v_token is distinct from p_token
     or v_status not in ('uploading', 'processing', 'deleting') then
    return false;
  end if;

  if v_status = 'processing' then
    update public.reviews
       set processing_status = 'failed',
           op_token = null,
           op_heartbeat_at = null,
           op_failed_at = null
     where id = p_review_id;
  else
    update public.reviews
       set op_failed_at = now()
     where id = p_review_id;
  end if;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. finish_upload: supersedes create_review_with_documents. Fenced on the upload
--    lease; validates shape; inserts documents; moves uploading -> draft. Does NOT
--    retire dead-attempt reminders (the finish gate's "folders currently empty"
--    check is enforced by the app, which lists Storage before calling this).
-- ---------------------------------------------------------------------------
create function public.finish_upload(
  p_review_id uuid,
  p_token uuid,
  p_documents jsonb   -- array of { role, filename, storage_path, participant_id? }
)
returns public.reviews
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_review public.reviews;
  v_report_count int;
  v_transcript_count int;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select * into v_review
  from public.reviews
  where id = p_review_id and user_id = v_user_id
  for update;
  if not found then
    raise exception 'review not found' using errcode = 'P0002';
  end if;

  if v_review.processing_status <> 'uploading'
     or v_review.op_token is distinct from p_token
     or v_review.op_failed_at is not null then
    raise exception 'upload lease lost or review not uploading' using errcode = 'P0001';
  end if;

  select
    count(*) filter (where d->>'role' = 'report'),
    count(*) filter (where d->>'role' = 'transcript')
  into v_report_count, v_transcript_count
  from jsonb_array_elements(p_documents) as d;

  if v_report_count <> 1 then
    raise exception 'exactly one report is required (got %)', v_report_count;
  end if;
  if v_transcript_count < 1 then
    raise exception 'at least one transcript is required';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_documents) as d
    where d->>'role' = 'transcript'
      and nullif(btrim(d->>'participant_id'), '') is null
  ) then
    raise exception 'each transcript must have a confirmed participant id';
  end if;

  insert into public.documents
    (review_id, user_id, role, filename, storage_path, participant_id)
  select
    p_review_id, v_user_id, d->>'role', d->>'filename', d->>'storage_path',
    nullif(btrim(d->>'participant_id'), '')
  from jsonb_array_elements(p_documents) as d;

  update public.reviews
     set processing_status = 'draft',
         op_token = null,
         op_heartbeat_at = null,
         op_failed_at = null
   where id = p_review_id
   returning * into v_review;

  return v_review;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. begin_review_op: start a check (processing) or deletion (deleting), using
--    database time for staleness and assigning a fresh lease. Enforces the agreed
--    transition table. Returns the new token, or NULL if not allowed.
-- ---------------------------------------------------------------------------
create function public.begin_review_op(p_review_id uuid, p_op text)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_status text;
  v_heartbeat timestamptz;
  v_failed timestamptz;
  v_new_token uuid := gen_random_uuid();
  v_recoverable boolean;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_op not in ('processing', 'deleting') then
    raise exception 'invalid op %', p_op using errcode = '22023';
  end if;

  select processing_status, op_heartbeat_at, op_failed_at
    into v_status, v_heartbeat, v_failed
  from public.reviews
  where id = p_review_id and user_id = v_user_id
  for update;
  if not found then
    return null;
  end if;

  -- A busy review is RECOVERABLE if confirmed failed or stale (no recent activity).
  v_recoverable :=
    v_status in ('uploading', 'processing', 'deleting')
    and (
      v_failed is not null
      or v_heartbeat is null
      or v_heartbeat <= now() - interval '2 minutes'
    );

  if p_op = 'processing' then
    -- From draft or failed, or RETRY a recoverable processing (on its saved files).
    -- Never from uploading (must finish the upload first), never complete (no
    -- re-run), never an ACTIVE busy review.
    if not (
      v_status in ('draft', 'failed')
      or (v_status = 'processing' and v_recoverable)
    ) then
      return null;
    end if;
  else  -- deleting
    -- From draft, complete, or failed; or reclaim/recover a RECOVERABLE
    -- uploading/processing/deleting. Never an ACTIVE busy review.
    if not (
      v_status in ('draft', 'complete', 'failed')
      or v_recoverable
    ) then
      return null;
    end if;
  end if;

  update public.reviews
     set processing_status = p_op,
         op_token = v_new_token,
         op_heartbeat_at = now(),
         op_failed_at = null
   where id = p_review_id;

  return v_new_token;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. record_quotation_results: now FENCED on the check lease. Superseded or
--    confirmed-failed checks write nothing. Sets `complete` only here, in the same
--    transaction as the saved results. (Replaces the 2-arg version.)
-- ---------------------------------------------------------------------------
drop function if exists public.record_quotation_results(uuid, jsonb);

create function public.record_quotation_results(
  p_review_id uuid,
  p_results jsonb,
  p_op_token uuid
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_status text;
  v_token uuid;
  v_failed timestamptz;
  v_quotation jsonb;
  v_issue jsonb;
  v_quotation_id uuid;
  v_count integer := 0;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select processing_status, op_token, op_failed_at
    into v_status, v_token, v_failed
  from public.reviews
  where id = p_review_id and user_id = v_user_id
  for update;
  if not found then
    raise exception 'review not found' using errcode = 'P0002';
  end if;
  if v_status <> 'processing'
     or v_token is distinct from p_op_token
     or v_failed is not null then
    raise exception 'check lease lost' using errcode = 'P0001';
  end if;

  delete from public.quotations where review_id = p_review_id;

  for v_quotation in
    select value from jsonb_array_elements(coalesce(p_results, '[]'::jsonb))
  loop
    insert into public.quotations (
      review_id, report_document_id, user_id, original_text,
      listed_participant_id, start_offset, end_offset, checking_result,
      matched_document_id, matched_excerpt
    )
    values (
      p_review_id,
      (v_quotation->>'report_document_id')::uuid,
      v_user_id,
      v_quotation->>'original_text',
      v_quotation->>'listed_participant_id',
      (v_quotation->>'start_offset')::integer,
      (v_quotation->>'end_offset')::integer,
      v_quotation->>'checking_result',
      (v_quotation->>'matched_document_id')::uuid,
      v_quotation->>'matched_excerpt'
    )
    returning id into v_quotation_id;

    for v_issue in
      select value from jsonb_array_elements(coalesce(v_quotation->'issues', '[]'::jsonb))
    loop
      insert into public.issues (
        review_id, quotation_id, user_id, issue_type, explanation,
        source_document_id, source_excerpt
      )
      values (
        p_review_id,
        v_quotation_id,
        v_user_id,
        v_issue->>'issue_type',
        v_issue->>'explanation',
        (v_issue->>'source_document_id')::uuid,
        v_issue->>'source_excerpt'
      );
    end loop;

    v_count := v_count + 1;
  end loop;

  update public.reviews
     set processing_status = 'complete',
         op_token = null,
         op_heartbeat_at = null,
         op_failed_at = null
   where id = p_review_id;

  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. finalize_review_deletion: the ONLY path that deletes a review row. Fenced on
--     the delete lease. Creates the durable whole-prefix cleanup record and deletes
--     the row (cascade) in ONE transaction, and scopes the decision-guard exception
--     to exactly this review via a transaction-local setting.
-- ---------------------------------------------------------------------------
create function public.finalize_review_deletion(p_review_id uuid, p_token uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_status text;
  v_token uuid;
  v_failed timestamptz;
  v_prefix text;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select processing_status, op_token, op_failed_at
    into v_status, v_token, v_failed
  from public.reviews
  where id = p_review_id and user_id = v_user_id
  for update;
  if not found then
    return false;
  end if;
  if v_status <> 'deleting'
     or v_token is distinct from p_token
     or v_failed is not null then
    raise exception 'delete lease lost or review not deleting' using errcode = 'P0001';
  end if;

  v_prefix := v_user_id::text || '/' || p_review_id::text;

  -- Successor whole-prefix record MUST exist before the row is deleted (the BEFORE
  -- DELETE guard enforces this). Idempotent across retries.
  insert into public.review_file_cleanups (user_id, review_id, prefix)
  values (v_user_id, p_review_id, v_prefix)
  on conflict (user_id, prefix) do update set finalized_at = now();

  -- Scope the decision-guard cascade exception to THIS review only (txn-local).
  perform set_config('app.deleting_review', p_review_id::text, true);

  delete from public.reviews where id = p_review_id;

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. Decision guard: block making/changing decisions (INSERT/UPDATE) and DELETE
--     while the parent review is busy (uploading/processing/deleting). DELETE is
--     guarded for protection only -- the app never clears decisions -- EXCEPT the
--     review's own deletion cascade, which is allowed via the scoped txn setting
--     (and also allowed when the parent review row is already gone).
-- ---------------------------------------------------------------------------
create function public.reject_decision_during_op()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_issue_id uuid := coalesce(new.issue_id, old.issue_id);
  v_review_id uuid;
  v_status text;
  v_flag text;
begin
  select r.id, r.processing_status
    into v_review_id, v_status
  from public.issues i
  join public.reviews r on r.id = i.review_id
  where i.id = v_issue_id
  for share of r;

  if not found then
    -- Parent review/issue already gone -> this is a cascade; allow.
    return coalesce(new, old);
  end if;

  v_flag := current_setting('app.deleting_review', true);
  if v_flag is not null and v_flag = v_review_id::text then
    return coalesce(new, old);  -- this review's own deletion cascade
  end if;

  if v_status in ('uploading', 'processing', 'deleting') then
    raise exception 'review is % and cannot accept decision changes', v_status
      using errcode = 'P0001';
  end if;

  return coalesce(new, old);
end;
$$;

create trigger review_decisions_reject_during_op
  before insert or update or delete on public.review_decisions
  for each row execute function public.reject_decision_during_op();

-- ---------------------------------------------------------------------------
-- 12. Delete guard: a review row may not be deleted without its successor
--     whole-prefix cleanup record (so deleting DB rows never orphans Storage
--     files). finalize_review_deletion inserts the record just before deleting.
-- ---------------------------------------------------------------------------
create function public.require_cleanup_record_before_delete()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_prefix text := old.user_id::text || '/' || old.id::text;
begin
  if not exists (
    select 1 from public.review_file_cleanups c
    where c.user_id = old.user_id and c.prefix = v_prefix
  ) then
    raise exception
      'cannot delete review % without a whole-prefix cleanup record for its files',
      old.id using errcode = 'P0001';
  end if;
  return old;
end;
$$;

create trigger reviews_require_cleanup_before_delete
  before delete on public.reviews
  for each row execute function public.require_cleanup_record_before_delete();

-- ---------------------------------------------------------------------------
-- 13. Least privilege: only signed-in users may call these functions.
-- ---------------------------------------------------------------------------
revoke all on function public.begin_upload(text) from public, anon;
grant execute on function public.begin_upload(text) to authenticated;

revoke all on function public.retry_upload(uuid) from public, anon;
grant execute on function public.retry_upload(uuid) to authenticated;

revoke all on function public.touch_review_op(uuid, uuid) from public, anon;
grant execute on function public.touch_review_op(uuid, uuid) to authenticated;

revoke all on function public.fail_review_op(uuid, uuid) from public, anon;
grant execute on function public.fail_review_op(uuid, uuid) to authenticated;

revoke all on function public.finish_upload(uuid, uuid, jsonb) from public, anon;
grant execute on function public.finish_upload(uuid, uuid, jsonb) to authenticated;

revoke all on function public.begin_review_op(uuid, text) from public, anon;
grant execute on function public.begin_review_op(uuid, text) to authenticated;

revoke all on function public.record_quotation_results(uuid, jsonb, uuid) from public, anon;
grant execute on function public.record_quotation_results(uuid, jsonb, uuid) to authenticated;

revoke all on function public.finalize_review_deletion(uuid, uuid) from public, anon;
grant execute on function public.finalize_review_deletion(uuid, uuid) to authenticated;
