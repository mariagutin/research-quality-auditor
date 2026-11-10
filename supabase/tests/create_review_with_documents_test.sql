-- =============================================================================
-- Synthetic test for public.create_review_with_documents(...)
-- (migration 20261109000000_create_review_with_documents_function.sql).
--
-- WHAT THIS CHECKS:
--   0. Not authenticated   - with no signed-in user, the call is rejected and
--                            writes nothing.
--   1. Happy path          - 1 report + 2 transcripts creates 1 review (status
--                            'draft') + 3 documents; each transcript's confirmed
--                            participant id is saved; the report's is NULL.
--   2. Exactly one report  - zero reports and two reports are both rejected, and
--                            leave NO rows behind.
--   3. At least one transcript - a report with no transcript is rejected, leaves
--                            no rows.
--   4. Transcript participant-id guard - a transcript whose participant id is
--                            MISSING, and one whose participant id is BLANK, are
--                            both rejected, leaving no rows.
--   5. Atomic rollback on document-insert failure - a set that passes every
--                            up-front rule but makes the DOCUMENT insert fail
--                            (a NULL storage_path) must undo the `reviews` row
--                            the function already inserted: zero rows remain.
--
-- Each rejection is checked two ways: the call must RAISE, and afterwards the
-- target review id must have ZERO reviews and ZERO documents -- proving the
-- single-transaction "all or nothing" guarantee.
--
-- SAFETY / CLEANUP:
--   * SYNTHETIC DATA ONLY. One fake user (@synthetic.test) and fake rows.
--   * The whole script runs inside ONE transaction and ends with ROLLBACK, so it
--     leaves NOTHING behind -- re-runnable, no cleanup needed.
--   * LOCAL, disposable Supabase stack only. Never run against hosted Supabase.
--
-- HOW TO RUN (local Postgres container; see supabase/tests/README.md):
--   docker exec -i supabase_db_research-quality-auditor \
--     psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--     -f - < supabase/tests/create_review_with_documents_test.sql
--
-- A clean run prints PASS notices and ends with "ALL CHECKS PASSED" (exit 0).
-- Any failed check RAISEs and aborts (exit 3 under psql -v ON_ERROR_STOP=1); the
-- transaction still rolls back.
-- =============================================================================

\set ON_ERROR_STOP on

begin;

-- One synthetic auth user (as superuser; RLS does not apply to this insert).
insert into auth.users (instance_id, id, aud, role, email)
values
  ('00000000-0000-0000-0000-000000000000',
   '00000000-0000-0000-0000-00000000000a',
   'authenticated', 'authenticated', 'user-a@synthetic.test');

do $$ begin raise notice 'SETUP: created 1 synthetic auth user'; end $$;

-- ===========================================================================
-- 0. NOT AUTHENTICATED - acting as superuser (no JWT), auth.uid() is NULL.
--    The call must be rejected and write nothing.
-- ===========================================================================
do $$
declare
  n int;
  v_raised boolean := false;
  v_msg text;
begin
  begin
    perform public.create_review_with_documents(
      '00000000-0000-0000-0000-0000000000f0',
      'should-not-exist',
      '[{"role":"report","filename":"r.md","storage_path":"u/r/r.md"},
        {"role":"transcript","filename":"p03.md","storage_path":"u/r/p03.md","participant_id":"P03"}]'::jsonb
    );
  exception when others then
    v_raised := true; v_msg := sqlerrm;
  end;
  if not v_raised then
    raise exception 'FAIL 0: unauthenticated call was allowed to succeed';
  end if;
  if v_msg not like '%not authenticated%' then
    raise exception 'FAIL 0: wrong error for unauthenticated call: %', v_msg;
  end if;
  select count(*) into n from public.reviews where id = '00000000-0000-0000-0000-0000000000f0';
  if n <> 0 then raise exception 'FAIL 0: a review row was left behind (got %)', n; end if;
  raise notice 'PASS 0: unauthenticated call rejected (%), left no rows', v_msg;
end $$;

-- From here on, act as the signed-in synthetic user.
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', false);
set role authenticated;

-- ===========================================================================
-- 1. HAPPY PATH - 1 report + 2 transcripts (each with a participant id).
-- ===========================================================================
do $$
declare
  n int;
  v_status text;
  v_name text;
  v_report_pid text;
  v_p03 text;
  v_p05 text;
begin
  perform public.create_review_with_documents(
    '00000000-0000-0000-0000-0000000000a1',
    'interview-study',
    '[{"role":"report","filename":"report.md","storage_path":"a/a1/report.md"},
      {"role":"transcript","filename":"p03.md","storage_path":"a/a1/p03.md","participant_id":"P03"},
      {"role":"transcript","filename":"p05.md","storage_path":"a/a1/p05.md","participant_id":" P05 "}]'::jsonb
  );

  -- One review, correct name, pre-check 'draft' status.
  select count(*) into n from public.reviews where id = '00000000-0000-0000-0000-0000000000a1';
  if n <> 1 then raise exception 'FAIL 1: expected 1 review, got %', n; end if;
  select name, processing_status into v_name, v_status
    from public.reviews where id = '00000000-0000-0000-0000-0000000000a1';
  if v_name <> 'interview-study' then raise exception 'FAIL 1: wrong name %', v_name; end if;
  if v_status <> 'draft' then raise exception 'FAIL 1: expected draft status, got %', v_status; end if;

  -- Three documents.
  select count(*) into n from public.documents where review_id = '00000000-0000-0000-0000-0000000000a1';
  if n <> 3 then raise exception 'FAIL 1: expected 3 documents, got %', n; end if;

  -- Report participant id is NULL.
  select participant_id into v_report_pid
    from public.documents
    where review_id = '00000000-0000-0000-0000-0000000000a1' and role = 'report';
  if v_report_pid is not null then
    raise exception 'FAIL 1: report participant_id should be NULL, got %', v_report_pid;
  end if;

  -- Transcript participant ids saved (and the blank-padded one trimmed to 'P05').
  select participant_id into v_p03
    from public.documents
    where review_id = '00000000-0000-0000-0000-0000000000a1' and filename = 'p03.md';
  select participant_id into v_p05
    from public.documents
    where review_id = '00000000-0000-0000-0000-0000000000a1' and filename = 'p05.md';
  if v_p03 <> 'P03' then raise exception 'FAIL 1: expected P03, got %', v_p03; end if;
  if v_p05 <> 'P05' then raise exception 'FAIL 1: expected trimmed P05, got "%"', v_p05; end if;

  raise notice 'PASS 1: happy path - 1 review (draft) + 3 docs; transcript participant ids saved (P03, P05); report pid NULL';
end $$;

-- ===========================================================================
-- 2. EXACTLY ONE REPORT.
-- ===========================================================================

-- 2a. Zero reports (transcript only).
do $$
declare n int; v_raised boolean := false; v_msg text;
begin
  begin
    perform public.create_review_with_documents(
      '00000000-0000-0000-0000-0000000002a0',
      'no-report',
      '[{"role":"transcript","filename":"p03.md","storage_path":"a/x/p03.md","participant_id":"P03"}]'::jsonb
    );
  exception when others then v_raised := true; v_msg := sqlerrm;
  end;
  if not v_raised then raise exception 'FAIL 2a: zero-report call was allowed'; end if;
  if v_msg not like '%exactly one report%' then raise exception 'FAIL 2a: wrong error: %', v_msg; end if;
  select count(*) into n from public.reviews   where id = '00000000-0000-0000-0000-0000000002a0';
  if n <> 0 then raise exception 'FAIL 2a: review left behind (got %)', n; end if;
  select count(*) into n from public.documents where review_id = '00000000-0000-0000-0000-0000000002a0';
  if n <> 0 then raise exception 'FAIL 2a: documents left behind (got %)', n; end if;
  raise notice 'PASS 2a: zero reports rejected (%), no rows left', v_msg;
end $$;

-- 2b. Two reports.
do $$
declare n int; v_raised boolean := false; v_msg text;
begin
  begin
    perform public.create_review_with_documents(
      '00000000-0000-0000-0000-0000000002b0',
      'two-reports',
      '[{"role":"report","filename":"r1.md","storage_path":"a/x/r1.md"},
        {"role":"report","filename":"r2.md","storage_path":"a/x/r2.md"},
        {"role":"transcript","filename":"p03.md","storage_path":"a/x/p03.md","participant_id":"P03"}]'::jsonb
    );
  exception when others then v_raised := true; v_msg := sqlerrm;
  end;
  if not v_raised then raise exception 'FAIL 2b: two-report call was allowed'; end if;
  if v_msg not like '%exactly one report%' then raise exception 'FAIL 2b: wrong error: %', v_msg; end if;
  select count(*) into n from public.reviews   where id = '00000000-0000-0000-0000-0000000002b0';
  if n <> 0 then raise exception 'FAIL 2b: review left behind (got %)', n; end if;
  select count(*) into n from public.documents where review_id = '00000000-0000-0000-0000-0000000002b0';
  if n <> 0 then raise exception 'FAIL 2b: documents left behind (got %)', n; end if;
  raise notice 'PASS 2b: two reports rejected (%), no rows left', v_msg;
end $$;

-- ===========================================================================
-- 3. AT LEAST ONE TRANSCRIPT - a report with no transcript is rejected.
-- ===========================================================================
do $$
declare n int; v_raised boolean := false; v_msg text;
begin
  begin
    perform public.create_review_with_documents(
      '00000000-0000-0000-0000-000000000300',
      'no-transcript',
      '[{"role":"report","filename":"r.md","storage_path":"a/x/r.md"}]'::jsonb
    );
  exception when others then v_raised := true; v_msg := sqlerrm;
  end;
  if not v_raised then raise exception 'FAIL 3: no-transcript call was allowed'; end if;
  if v_msg not like '%at least one transcript%' then raise exception 'FAIL 3: wrong error: %', v_msg; end if;
  select count(*) into n from public.reviews   where id = '00000000-0000-0000-0000-000000000300';
  if n <> 0 then raise exception 'FAIL 3: review left behind (got %)', n; end if;
  select count(*) into n from public.documents where review_id = '00000000-0000-0000-0000-000000000300';
  if n <> 0 then raise exception 'FAIL 3: documents left behind (got %)', n; end if;
  raise notice 'PASS 3: missing transcript rejected (%), no rows left', v_msg;
end $$;

-- ===========================================================================
-- 4. TRANSCRIPT PARTICIPANT-ID GUARD - missing and blank are both rejected.
-- ===========================================================================

-- 4a. Participant id key MISSING on a transcript.
do $$
declare n int; v_raised boolean := false; v_msg text;
begin
  begin
    perform public.create_review_with_documents(
      '00000000-0000-0000-0000-0000000004a0',
      'missing-pid',
      '[{"role":"report","filename":"r.md","storage_path":"a/x/r.md"},
        {"role":"transcript","filename":"p03.md","storage_path":"a/x/p03.md"}]'::jsonb
    );
  exception when others then v_raised := true; v_msg := sqlerrm;
  end;
  if not v_raised then raise exception 'FAIL 4a: missing participant id was allowed'; end if;
  if v_msg not like '%participant id%' then raise exception 'FAIL 4a: wrong error: %', v_msg; end if;
  select count(*) into n from public.reviews   where id = '00000000-0000-0000-0000-0000000004a0';
  if n <> 0 then raise exception 'FAIL 4a: review left behind (got %)', n; end if;
  select count(*) into n from public.documents where review_id = '00000000-0000-0000-0000-0000000004a0';
  if n <> 0 then raise exception 'FAIL 4a: documents left behind (got %)', n; end if;
  raise notice 'PASS 4a: missing transcript participant id rejected (%), no rows left', v_msg;
end $$;

-- 4b. Participant id present but BLANK (whitespace) on a transcript.
do $$
declare n int; v_raised boolean := false; v_msg text;
begin
  begin
    perform public.create_review_with_documents(
      '00000000-0000-0000-0000-0000000004b0',
      'blank-pid',
      '[{"role":"report","filename":"r.md","storage_path":"a/x/r.md"},
        {"role":"transcript","filename":"p03.md","storage_path":"a/x/p03.md","participant_id":"   "}]'::jsonb
    );
  exception when others then v_raised := true; v_msg := sqlerrm;
  end;
  if not v_raised then raise exception 'FAIL 4b: blank participant id was allowed'; end if;
  if v_msg not like '%participant id%' then raise exception 'FAIL 4b: wrong error: %', v_msg; end if;
  select count(*) into n from public.reviews   where id = '00000000-0000-0000-0000-0000000004b0';
  if n <> 0 then raise exception 'FAIL 4b: review left behind (got %)', n; end if;
  select count(*) into n from public.documents where review_id = '00000000-0000-0000-0000-0000000004b0';
  if n <> 0 then raise exception 'FAIL 4b: documents left behind (got %)', n; end if;
  raise notice 'PASS 4b: blank transcript participant id rejected (%), no rows left', v_msg;
end $$;

-- ===========================================================================
-- 5. ATOMIC ROLLBACK ON DOCUMENT-INSERT FAILURE.
--    This set passes every up-front rule (1 report, 1 transcript with a
--    participant id), so the function DOES insert the review row -- then the
--    DOCUMENT insert fails because a storage_path is NULL (NOT NULL violation).
--    The whole transaction must roll back, undoing the review row.
-- ===========================================================================
do $$
declare n int; v_raised boolean := false; v_msg text;
begin
  begin
    perform public.create_review_with_documents(
      '00000000-0000-0000-0000-000000000500',
      'doc-insert-fails',
      -- report has NO storage_path -> NULL -> fails during the documents insert,
      -- AFTER the review row has already been inserted inside the function.
      '[{"role":"report","filename":"r.md"},
        {"role":"transcript","filename":"p03.md","storage_path":"a/x/p03.md","participant_id":"P03"}]'::jsonb
    );
  exception when others then v_raised := true; v_msg := sqlerrm;
  end;
  if not v_raised then raise exception 'FAIL 5: document-insert failure did not raise'; end if;
  if v_msg not like '%storage_path%' then raise exception 'FAIL 5: expected a storage_path NOT NULL failure, got: %', v_msg; end if;
  -- The key assertion: the review the function already inserted was undone.
  select count(*) into n from public.reviews   where id = '00000000-0000-0000-0000-000000000500';
  if n <> 0 then raise exception 'FAIL 5: the review row survived a failed document insert (got %)', n; end if;
  select count(*) into n from public.documents where review_id = '00000000-0000-0000-0000-000000000500';
  if n <> 0 then raise exception 'FAIL 5: documents survived a failed document insert (got %)', n; end if;
  raise notice 'PASS 5: document-insert failure (%) rolled back the already-inserted review row', v_msg;
end $$;

-- Confirm the one committed-in-transaction happy-path review is still the ONLY
-- review present (none of the rejected calls leaked a row).
do $$
declare n int;
begin
  select count(*) into n from public.reviews;
  if n <> 1 then raise exception 'FAIL final: expected exactly 1 review overall, got %', n; end if;
  raise notice 'PASS final: exactly 1 review exists (only the happy-path one); every rejection left nothing';
end $$;

reset role;
select set_config('request.jwt.claims', '', false);

do $$ begin raise notice '================  ALL CHECKS PASSED  ================'; end $$;

-- Roll everything back: no synthetic data persists.
rollback;
