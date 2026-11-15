-- =============================================================================
-- Synthetic Storage RLS test for the `review-files` bucket.
--   * Owner-only SELECT/DELETE + no-UPDATE policies
--     (migration 20261110000000_create_review_files_storage_bucket.sql).
--   * The upload-attempt INSERT policy
--     (migration 20261112010000_tie_review_uploads_to_current_attempt.sql):
--     a PUT is allowed ONLY under {uid}/{reviewId}/{op_token}/... of the caller's
--     own review that is `uploading`, not confirmed-failed, with a matching token.
--
-- DATABASE POLICY TEST ONLY. This inserts rows straight into storage.objects to
-- exercise the RLS WITH CHECK / USING predicates. It is NOT a real Storage
-- upload/delete test: it does not move bytes over the Storage HTTP API, so it does
-- not cover an already-accepted in-flight PUT finalizing after takeover, the
-- convention sweeps, or real multi-op overlap. Those belong to the app-wiring +
-- real-Storage phase (see the "NOT COVERED" note at the end).
--
-- WHAT THIS CHECKS, with two synthetic users (Anna = ...0a, Bob = ...0b):
--   1.  Anna can upload into her CURRENT attempt folder
--       {anna}/{R1}/{T1}/... while R1 is `uploading` with op_token T1.
--   2a. A WRONG token segment (a retired/stale attempt) is rejected.
--   2b. A reviewId with no matching uploading review (e.g. after deletion) is
--       rejected.
--   2c. The SAME review once it is no longer `uploading` (here: draft) rejects a
--       further upload -- no "additional" uploads after the window.
--   2d. A CONFIRMED-failed attempt (op_failed_at set) is rejected.
--   3.  Anna cannot write into Bob's folder (first-folder owner check).
--   4.  No move/rename -- there is no UPDATE policy, so an UPDATE matches 0 rows
--       (both into Bob's folder and within Anna's own folder).
--   5.  Bob cannot SEE (hence cannot download) Anna's files (owner-only SELECT;
--       a Storage download is gated by this same SELECT policy).
--   5b. Bob cannot DELETE Anna's files by direct SQL. storage.objects carries a
--       STATEMENT-level BEFORE DELETE trigger (Supabase's protect_delete) that
--       blocks EVERY direct SQL delete -- owner or not -- so deletes must go through
--       the Storage API. We assert the invariant: Bob's statement removes 0 of
--       Anna's files. The cross-user guarantee for the API delete PATH is the
--       owner-only DELETE policy, whose USING predicate is byte-identical to the
--       SELECT policy proven empty for Bob in check 5; an end-to-end HTTP
--       delete-as-Bob belongs to the real-Storage phase (see the NOT COVERED note).
--   6.  Signed-out (anon) sees nothing and cannot upload.
--   7.  Final sweep (RLS bypassed), SCOPED TO THE SYNTHETIC USERS' prefixes only
--       (so pre-existing local dev files in the bucket are ignored): exactly
--       Anna's one file exists; Bob's prefix is empty.
--
-- SAFETY / CLEANUP:
--   * SYNTHETIC DATA ONLY: fake users + fake storage.objects rows (no real bytes).
--   * ONE transaction that ends with ROLLBACK -- re-runnable, no cleanup, and it
--     leaves any existing local bucket files untouched.
--   * LOCAL, disposable Supabase only. Never run against hosted Supabase.
--
-- HOW TO RUN (see supabase/tests/README.md):
--   docker exec -i supabase_db_research-quality-auditor \
--     psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--     -f - < supabase/tests/review_files_storage_test.sql
-- =============================================================================

\set ON_ERROR_STOP on

begin;

-- Two synthetic auth users (as superuser; RLS does not apply to this insert).
insert into auth.users (instance_id, id, aud, role, email)
values
  ('00000000-0000-0000-0000-000000000000',
   '00000000-0000-0000-0000-00000000000a',
   'authenticated', 'authenticated', 'anna@synthetic.test'),
  ('00000000-0000-0000-0000-000000000000',
   '00000000-0000-0000-0000-00000000000b',
   'authenticated', 'authenticated', 'bob@synthetic.test');

do $$ begin raise notice 'SETUP: created synthetic users Anna (...0a) and Bob (...0b)'; end $$;

-- ===========================================================================
-- Act as Anna.
-- ===========================================================================
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', false);
set role authenticated;

-- Anna's current upload attempt: review R1 (...a1), `uploading`, op_token T1 (...c1).
-- Path prefix: {anna}/{R1}/{T1}/...
insert into public.reviews (id, user_id, name, processing_status, op_token, op_heartbeat_at)
values ('00000000-0000-0000-0000-0000000000a1',
        '00000000-0000-0000-0000-00000000000a',
        'Upload in progress', 'uploading',
        '00000000-0000-0000-0000-0000000000c1', now());

do $$ begin raise notice 'SETUP: Anna has an uploading review R1 with current token T1'; end $$;

-- 1a. Anna uploads into her CURRENT attempt folder -> allowed.
do $$
declare n int;
begin
  insert into storage.objects (bucket_id, name)
  values ('review-files',
    '00000000-0000-0000-0000-00000000000a/00000000-0000-0000-0000-0000000000a1/00000000-0000-0000-0000-0000000000c1/report.md');
  select count(*) into n from storage.objects
   where name like '00000000-0000-0000-0000-00000000000a/%';
  if n <> 1 then raise exception 'FAIL 1a: Anna could not create/see her own file (got %)', n; end if;
  raise notice 'PASS 1a: Anna can upload into her current attempt folder {anna}/{R1}/{T1}/';
end $$;

-- 2a. A WRONG token segment (retired/stale attempt) -> rejected.
do $$
declare v_raised boolean := false; v_msg text;
begin
  begin
    insert into storage.objects (bucket_id, name)
    values ('review-files',
      '00000000-0000-0000-0000-00000000000a/00000000-0000-0000-0000-0000000000a1/00000000-0000-0000-0000-0000000000cc/late.md');
  exception when others then v_raised := true; v_msg := sqlerrm;
  end;
  if not v_raised then raise exception 'FAIL 2a: an upload with a non-current token was allowed'; end if;
  raise notice 'PASS 2a: a retired/stale attempt token is rejected (%)', v_msg;
end $$;

-- 2b. A reviewId with NO matching uploading review (e.g. deleted) -> rejected.
do $$
declare v_raised boolean := false; v_msg text;
begin
  begin
    insert into storage.objects (bucket_id, name)
    values ('review-files',
      '00000000-0000-0000-0000-00000000000a/00000000-0000-0000-0000-0000000000ff/00000000-0000-0000-0000-0000000000c1/orphan.md');
  exception when others then v_raised := true; v_msg := sqlerrm;
  end;
  if not v_raised then raise exception 'FAIL 2b: an upload for a non-existent review was allowed'; end if;
  raise notice 'PASS 2b: an upload for a review with no uploading row (e.g. deleted) is rejected (%)', v_msg;
end $$;

-- 2c. The review is no longer `uploading` (draft) -> further upload rejected.
do $$
declare v_raised boolean := false; v_msg text;
begin
  update public.reviews set processing_status = 'draft', op_token = null
   where id = '00000000-0000-0000-0000-0000000000a1';
  begin
    insert into storage.objects (bucket_id, name)
    values ('review-files',
      '00000000-0000-0000-0000-00000000000a/00000000-0000-0000-0000-0000000000a1/00000000-0000-0000-0000-0000000000c1/extra.md');
  exception when others then v_raised := true; v_msg := sqlerrm;
  end;
  if not v_raised then raise exception 'FAIL 2c: an additional upload after the upload window was allowed'; end if;
  raise notice 'PASS 2c: once the review is not uploading, additional uploads are rejected (%)', v_msg;
end $$;

-- 2d. A CONFIRMED-failed attempt (op_failed_at set) -> rejected.
do $$
declare v_raised boolean := false; v_msg text;
begin
  update public.reviews
     set processing_status = 'uploading',
         op_token = '00000000-0000-0000-0000-0000000000c1',
         op_heartbeat_at = now(),
         op_failed_at = now()            -- confirmed failure
   where id = '00000000-0000-0000-0000-0000000000a1';
  begin
    insert into storage.objects (bucket_id, name)
    values ('review-files',
      '00000000-0000-0000-0000-00000000000a/00000000-0000-0000-0000-0000000000a1/00000000-0000-0000-0000-0000000000c1/afterfail.md');
  exception when others then v_raised := true; v_msg := sqlerrm;
  end;
  if not v_raised then raise exception 'FAIL 2d: an upload to a confirmed-failed attempt was allowed'; end if;
  -- Restore R1 to a live uploading attempt for the remaining (rename) checks.
  update public.reviews set op_failed_at = null where id = '00000000-0000-0000-0000-0000000000a1';
  raise notice 'PASS 2d: a confirmed-failed attempt rejects further uploads (%)', v_msg;
end $$;

-- 3. Anna tries to UPLOAD into Bob's folder -> rejected (first-folder owner check).
do $$
declare v_raised boolean := false; v_msg text;
begin
  begin
    insert into storage.objects (bucket_id, name)
    values ('review-files',
      '00000000-0000-0000-0000-00000000000b/x/y/steal.md');
  exception when others then v_raised := true; v_msg := sqlerrm;
  end;
  if not v_raised then raise exception 'FAIL 3: Anna was allowed to upload into Bob''s folder'; end if;
  raise notice 'PASS 3: Anna cannot upload into Bob''s folder (%)', v_msg;
end $$;

-- 4. No move/rename (no UPDATE policy): an UPDATE matches 0 rows and changes nothing.
do $$
declare cnt int; n int;
begin
  update storage.objects
     set name = '00000000-0000-0000-0000-00000000000b/r1/t/report.md'
   where name = '00000000-0000-0000-0000-00000000000a/00000000-0000-0000-0000-0000000000a1/00000000-0000-0000-0000-0000000000c1/report.md';
  get diagnostics cnt = row_count;
  if cnt <> 0 then raise exception 'FAIL 4: an UPDATE changed % row(s) despite no UPDATE policy', cnt; end if;

  update storage.objects
     set name = '00000000-0000-0000-0000-00000000000a/00000000-0000-0000-0000-0000000000a1/00000000-0000-0000-0000-0000000000c1/renamed.md'
   where name = '00000000-0000-0000-0000-00000000000a/00000000-0000-0000-0000-0000000000a1/00000000-0000-0000-0000-0000000000c1/report.md';
  get diagnostics cnt = row_count;
  if cnt <> 0 then raise exception 'FAIL 4: an in-folder rename changed % row(s) despite no UPDATE policy', cnt; end if;

  select count(*) into n from storage.objects
   where name = '00000000-0000-0000-0000-00000000000a/00000000-0000-0000-0000-0000000000a1/00000000-0000-0000-0000-0000000000c1/report.md';
  if n <> 1 then raise exception 'FAIL 4: Anna''s file not intact after attempted moves (got %)', n; end if;
  raise notice 'PASS 4: no UPDATE policy -> move/rename changes 0 rows; Anna''s file intact';
end $$;

-- ===========================================================================
-- 5. Act as Bob -- blocked from Anna's files.
-- ===========================================================================
reset role;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}', false);
set role authenticated;

do $$
declare n int;
begin
  select count(*) into n from storage.objects
   where name like '00000000-0000-0000-0000-00000000000a/%';
  if n <> 0 then raise exception 'FAIL 5: Bob can see % of Anna''s objects (should be 0)', n; end if;
  raise notice 'PASS 5: Bob sees none of Anna''s files (so cannot download them)';
end $$;

-- 5b. Bob tries to DELETE Anna's file by direct SQL. A STATEMENT-level BEFORE
--     DELETE trigger (protect_delete) blocks every direct SQL delete against
--     storage.objects -- owner or not -- so this path cannot remove Anna's file.
--     Invariant asserted: 0 of Anna's files are removed (whether the statement is
--     blocked by the trigger or, with the trigger absent, filtered to 0 rows by the
--     owner-only DELETE policy). The API delete path's cross-user block is the
--     owner-only DELETE policy, identical in predicate to the SELECT policy proven
--     empty for Bob in check 5.
do $$
declare cnt int; v_blocked boolean := false; v_msg text;
begin
  begin
    delete from storage.objects
     where bucket_id = 'review-files'
       and name like '00000000-0000-0000-0000-00000000000a/%';
    get diagnostics cnt = row_count;
  exception when others then
    v_blocked := true; v_msg := sqlerrm; cnt := 0;
  end;
  if cnt <> 0 then raise exception 'FAIL 5b: Bob deleted % of Anna''s file(s)', cnt; end if;
  if v_blocked then
    raise notice 'PASS 5b: Bob''s direct-SQL delete of Anna''s files was blocked by protect_delete (%); 0 removed', v_msg;
  else
    raise notice 'PASS 5b: Bob''s direct-SQL delete matched 0 of Anna''s files (owner-only DELETE policy)';
  end if;
end $$;

-- ===========================================================================
-- 6. Signed-out visitor (anon) -- blocked.
-- ===========================================================================
reset role;
select set_config('request.jwt.claims', '{"role":"anon"}', false);
set role anon;

do $$
declare n int; v_raised boolean := false;
begin
  select count(*) into n from storage.objects
   where name like '00000000-0000-0000-0000-00000000000a/%';
  if n <> 0 then raise exception 'FAIL 6a: signed-out visitor can see % objects', n; end if;

  begin
    insert into storage.objects (bucket_id, name)
    values ('review-files', '00000000-0000-0000-0000-00000000000a/00000000-0000-0000-0000-0000000000a1/00000000-0000-0000-0000-0000000000c1/anon.md');
  exception when others then v_raised := true;
  end;
  if not v_raised then raise exception 'FAIL 6b: signed-out visitor was allowed to upload'; end if;
  raise notice 'PASS 6: signed-out visitor sees no files and cannot upload';
end $$;

-- ===========================================================================
-- 7. Final sweep (RLS bypassed), SCOPED to the synthetic users' prefixes so any
--    pre-existing local dev files in the bucket are ignored.
-- ===========================================================================
reset role;
select set_config('request.jwt.claims', '', false);
do $$
declare n int;
begin
  select count(*) into n from storage.objects
   where name like '00000000-0000-0000-0000-00000000000b/%';
  if n <> 0 then raise exception 'FAIL 7: % objects exist under Bob''s prefix (should be 0)', n; end if;

  select count(*) into n from storage.objects
   where name like '00000000-0000-0000-0000-00000000000a/%';
  if n <> 1 then raise exception 'FAIL 7: expected exactly 1 object under Anna''s prefix, got %', n; end if;

  raise notice 'PASS 7: exactly Anna''s 1 file exists; Bob''s prefix empty; synthetic scope only';
end $$;

do $$ begin raise notice '================  ALL CHECKS PASSED  ================'; end $$;

-- NOT COVERED HERE (requires the app-wiring + real-Storage phase):
--   * a real already-accepted PUT finalizing AFTER takeover (in-flight late file);
--   * the convention cleanup sweeps actually removing folders over the Storage API;
--   * real multi-op overlap: upload/check, upload/delete, check/delete,
--     decision/delete, and two reviews proceeding independently;
--   * the T2-vs-T3 fixed-target reminder cleanup with real files.
-- Those are Storage upload/delete tests, distinct from this database policy test.

-- Roll everything back: no synthetic data persists; existing bucket files untouched.
rollback;
