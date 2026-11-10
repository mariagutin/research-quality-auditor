-- =============================================================================
-- Synthetic Storage RLS test for the `review-files` bucket
-- (migration 20261110000000_create_review_files_storage_bucket.sql).
--
-- WHAT THIS CHECKS, with two synthetic users (Anna = ...0a, Bob = ...0b):
--   1. Anna's own folder works - she can INSERT and SELECT objects whose first
--      path folder is her own user id.
--   2. Anna cannot write into Bob's folder - an INSERT into Bob's folder is
--      rejected (INSERT WITH CHECK), leaving no row there.
--   3. Files cannot be moved/renamed - there is NO UPDATE policy, so an UPDATE
--      matches zero rows (RLS default-deny). (a) Anna renaming her file into
--      Bob's folder changes nothing; her file stays put and nothing lands in
--      Bob's. (b) Anna renaming the file WITHIN her own folder (report.md ->
--      report-renamed.md) also changes nothing - the stored Storage filename is
--      fixed. (This stored object name is separate from the title written inside
--      the report and from the review's display name.)
--   4. Bob is blocked from Anna's files - he cannot SELECT them (they are
--      invisible). (Object deletes run through the Storage API, which applies the
--      owner-only DELETE policy; direct SQL deletes are blocked outright by
--      Supabase's storage.protect_delete trigger, so a delete is not exercised
--      here. The DELETE policy uses the SAME owner predicate proven by the SELECT
--      checks below.)
--   5. Signed-out visitors are blocked - as `anon`, no files are visible and an
--      upload is rejected.
--   6. Final sweep (RLS bypassed) - exactly Anna's one file exists; Bob's folder
--      is empty; nothing leaked.
--
-- SAFETY / CLEANUP:
--   * SYNTHETIC DATA ONLY: two fake users and fake Storage rows (no real bytes;
--     rows are inserted straight into storage.objects). No real files are touched.
--   * The whole script runs in ONE transaction that ends with ROLLBACK, so it
--     leaves NOTHING behind - re-runnable, no cleanup needed.
--   * LOCAL, disposable Supabase stack only. Never run against hosted Supabase.
--
-- HOW TO RUN (see supabase/tests/README.md):
--   docker exec -i supabase_db_research-quality-auditor \
--     psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--     -f - < supabase/tests/review_files_storage_test.sql
--
-- A clean run prints PASS notices and ends with "ALL CHECKS PASSED" (exit 0).
-- Any failed check RAISEs and aborts (exit 3 under psql -v ON_ERROR_STOP=1); the
-- transaction still rolls back.
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

-- 1a. Anna uploads into her OWN folder -> allowed.
do $$
declare n int;
begin
  insert into storage.objects (bucket_id, name)
  values ('review-files', '00000000-0000-0000-0000-00000000000a/r1/report.md');
  select count(*) into n from storage.objects
   where name = '00000000-0000-0000-0000-00000000000a/r1/report.md';
  if n <> 1 then raise exception 'FAIL 1a: Anna could not create/see her own file (got %)', n; end if;
  raise notice 'PASS 1a: Anna can upload into her own folder';
end $$;

-- 1b. Anna SELECTs her own folder -> sees exactly her file.
do $$
declare n int;
begin
  select count(*) into n from storage.objects where bucket_id = 'review-files';
  if n <> 1 then raise exception 'FAIL 1b: Anna should see exactly 1 file, got %', n; end if;
  raise notice 'PASS 1b: Anna sees her own file';
end $$;

-- 2. Anna tries to UPLOAD into Bob's folder -> rejected (INSERT WITH CHECK).
do $$
declare v_raised boolean := false; v_msg text;
begin
  begin
    insert into storage.objects (bucket_id, name)
    values ('review-files', '00000000-0000-0000-0000-00000000000b/x/steal.md');
  exception when others then v_raised := true; v_msg := sqlerrm;
  end;
  if not v_raised then raise exception 'FAIL 2: Anna was allowed to upload into Bob''s folder'; end if;
  raise notice 'PASS 2: Anna cannot upload into Bob''s folder (%)', v_msg;
end $$;

-- 3. Anna tries to MOVE her file into Bob's folder (rename). With NO UPDATE
--    policy, RLS exposes zero updatable rows, so the UPDATE changes nothing
--    (0 rows) -- it does not even raise. Her file stays where it is.
do $$
declare cnt int; n int;
begin
  update storage.objects
     set name = '00000000-0000-0000-0000-00000000000b/r1/report.md'
   where name = '00000000-0000-0000-0000-00000000000a/r1/report.md';
  get diagnostics cnt = row_count;
  if cnt <> 0 then raise exception 'FAIL 3: an UPDATE changed % row(s) despite no UPDATE policy', cnt; end if;
  select count(*) into n from storage.objects
   where name = '00000000-0000-0000-0000-00000000000a/r1/report.md';
  if n <> 1 then raise exception 'FAIL 3: Anna''s file not intact after attempted move (got %)', n; end if;
  raise notice 'PASS 3: no UPDATE policy -> rename/move changes 0 rows; Anna''s file intact';
end $$;

-- 3b. Anna tries to RENAME her file WITHIN her own folder
--     (report.md -> report-renamed.md). This is purely the stored Storage object
--     name -- not the report's internal title, not the review's display name.
--     With no UPDATE policy it also changes 0 rows: the stored filename is fixed.
do $$
declare cnt int; n int;
begin
  update storage.objects
     set name = '00000000-0000-0000-0000-00000000000a/r1/report-renamed.md'
   where name = '00000000-0000-0000-0000-00000000000a/r1/report.md';
  get diagnostics cnt = row_count;
  if cnt <> 0 then raise exception 'FAIL 3b: an in-folder rename changed % row(s) despite no UPDATE policy', cnt; end if;
  select count(*) into n from storage.objects
   where name = '00000000-0000-0000-0000-00000000000a/r1/report.md';
  if n <> 1 then raise exception 'FAIL 3b: original filename not intact (got %)', n; end if;
  select count(*) into n from storage.objects
   where name = '00000000-0000-0000-0000-00000000000a/r1/report-renamed.md';
  if n <> 0 then raise exception 'FAIL 3b: a renamed file appeared (got %)', n; end if;
  raise notice 'PASS 3b: Anna cannot rename her file within her own folder; stored filename fixed';
end $$;

-- ===========================================================================
-- Act as Bob - blocked from Anna's files.
-- ===========================================================================
reset role;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}', false);
set role authenticated;

-- 4a. Bob cannot SEE Anna's file (and has none of his own) -> sees nothing.
do $$
declare n int;
begin
  select count(*) into n from storage.objects where bucket_id = 'review-files';
  if n <> 0 then raise exception 'FAIL 4: Bob can see % objects (should be 0)', n; end if;
  perform 1 from storage.objects
   where name = '00000000-0000-0000-0000-00000000000a/r1/report.md';
  if found then raise exception 'FAIL 4: Bob can see Anna''s file by name'; end if;
  raise notice 'PASS 4: Bob sees none of Anna''s files';
end $$;

-- ===========================================================================
-- 5. Signed-out visitor (anon) - blocked.
-- ===========================================================================
reset role;
select set_config('request.jwt.claims', '{"role":"anon"}', false);
set role anon;

-- 5a. anon sees no files.
do $$
declare n int;
begin
  select count(*) into n from storage.objects where bucket_id = 'review-files';
  if n <> 0 then raise exception 'FAIL 5a: signed-out visitor can see % objects', n; end if;
  raise notice 'PASS 5a: signed-out visitor sees no files';
end $$;

-- 5b. anon cannot upload (no policy grants anon INSERT) -> rejected.
do $$
declare v_raised boolean := false; v_msg text;
begin
  begin
    insert into storage.objects (bucket_id, name)
    values ('review-files', '00000000-0000-0000-0000-00000000000a/r1/anon.md');
  exception when others then v_raised := true; v_msg := sqlerrm;
  end;
  if not v_raised then raise exception 'FAIL 5b: signed-out visitor was allowed to upload'; end if;
  raise notice 'PASS 5b: signed-out visitor cannot upload (%)', v_msg;
end $$;

-- ===========================================================================
-- 6. Final sweep with RLS BYPASSED (superuser) - ground truth.
-- ===========================================================================
reset role;
select set_config('request.jwt.claims', '', false);
do $$
declare n int;
begin
  select count(*) into n from storage.objects
   where bucket_id = 'review-files'
     and name like '00000000-0000-0000-0000-00000000000b/%';
  if n <> 0 then raise exception 'FAIL 6: % objects exist in Bob''s folder (should be 0)', n; end if;

  select count(*) into n from storage.objects
   where name = '00000000-0000-0000-0000-00000000000a/r1/report.md';
  if n <> 1 then raise exception 'FAIL 6: Anna''s file missing (got %)', n; end if;

  select count(*) into n from storage.objects where bucket_id = 'review-files';
  if n <> 1 then raise exception 'FAIL 6: expected exactly 1 object in the bucket, got %', n; end if;

  raise notice 'PASS 6: exactly Anna''s 1 file exists; Bob''s folder empty; nothing leaked';
end $$;

do $$ begin raise notice '================  ALL CHECKS PASSED  ================'; end $$;

-- Roll everything back: no synthetic data persists.
rollback;
