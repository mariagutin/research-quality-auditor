-- =============================================================================
-- Synthetic two-user RLS + constraint test for the Research Quality Auditor
-- schema (migration 20261105000000_init_research_quality_auditor_schema.sql).
--
-- WHAT THIS CHECKS (mirrors the "Verified against a local Supabase" claims in
-- docs/database-design.md):
--   1. Owner happy path  - an owner can create the full review graph under RLS.
--   2. Isolation         - each user sees ONLY their own rows; not the other's.
--   3. RLS rejections    - a user cannot spoof ownership or link into another
--                          user's review (insufficient_privilege / 42501).
--   4. Structural rejections - the composite foreign keys reject owner-mismatch,
--                          wrong document-role, and cross-review links even when
--                          RLS is BYPASSED (service-role / superuser, 23503).
--   5. Evidence-free issue - a `quote_not_found` issue with no transcript is
--                          accepted (source_document_id IS NULL).
--   6. Cascade delete    - deleting a review removes its children, while the
--                          OTHER user's data and the owner's other review survive.
--
-- SAFETY / CLEANUP:
--   * SYNTHETIC DATA ONLY. Two fake users (emails @synthetic.test) and fake rows.
--   * The whole script runs inside ONE transaction and ends with ROLLBACK, so it
--     leaves NOTHING behind - re-runnable any number of times, no cleanup needed.
--     (Even if interrupted, an open transaction rolls back when the session ends.)
--   * Intended for a LOCAL, disposable Supabase stack only. Never run against
--     hosted Supabase.
--
-- HOW TO RUN: see supabase/tests/README.md.
-- A clean run prints a series of "PASS:" NOTICEs and finishes with
-- "ALL CHECKS PASSED". Any failure RAISEs an exception and aborts (exit code 3
-- under psql -v ON_ERROR_STOP=1), and the transaction still rolls back.
-- =============================================================================

\set ON_ERROR_STOP on

begin;

-- Fixed synthetic UUIDs so the script is readable and self-referential.
-- (These never touch real data; everything is rolled back.)
--   users:   a / b
--   reviews: a1, a2 (user A), b1 (user B)
--   docs:    d1 report(A1), d2 transcript(A1), d3 report(A2), d4 report(B1)
--   quotes:  c1 (A1), c2 (A2)
--   issues:  e1 (with evidence), e2 (quote_not_found, no evidence)
--   decision:f1 (on e1)

-- ---------------------------------------------------------------------------
-- 0. Create two synthetic auth users (as superuser; RLS does not apply here).
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email)
values
  ('00000000-0000-0000-0000-000000000000',
   '00000000-0000-0000-0000-00000000000a',
   'authenticated', 'authenticated', 'user-a@synthetic.test'),
  ('00000000-0000-0000-0000-000000000000',
   '00000000-0000-0000-0000-00000000000b',
   'authenticated', 'authenticated', 'user-b@synthetic.test');

do $$ begin raise notice 'SETUP: created 2 synthetic auth users'; end $$;

-- ===========================================================================
-- 1. OWNER HAPPY PATH - user A builds a full review graph, all under RLS.
-- ===========================================================================
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', false);
set role authenticated;

-- Reviews
insert into public.reviews (id, user_id, name) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000a', 'Synthetic Review A1'),
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-00000000000a', 'Synthetic Review A2');

-- Documents (report + transcript in A1; report in A2)
insert into public.documents (id, review_id, user_id, role, filename, storage_path) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000a', 'report',     'report-a1.md',     'a/a1/report-a1.md'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000a', 'transcript', 'transcript-a1.md', 'a/a1/transcript-a1.md'),
  ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-00000000000a', 'report',     'report-a2.md',     'a/a2/report-a2.md');

-- Quotations (one per review, each pointing at its report document)
insert into public.quotations
  (id, review_id, report_document_id, user_id, original_text, start_offset, end_offset, checking_result) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-00000000000a', 'Participants reported high satisfaction.', 0, 40, 'has_issues'),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-00000000000a', 'No concerns were raised.', 0, 24, 'no_issues');

-- Issues on quotation c1: one WITH transcript evidence, one evidence-free quote_not_found.
insert into public.issues
  (id, review_id, quotation_id, user_id, issue_type, explanation, source_document_id, source_excerpt) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000000a', 'wording_mismatch', 'Quote wording differs from transcript.', '00000000-0000-0000-0000-0000000000d2', 'participants said it was fine');
insert into public.issues
  (id, review_id, quotation_id, user_id, issue_type, explanation, source_document_id) values
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000000a', 'quote_not_found', 'Quote not located in any transcript.', null);

-- Decision on the evidence-backed issue
insert into public.review_decisions (id, issue_id, user_id, decision) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-00000000000a', 'needs_correction');

do $$ begin raise notice 'PASS 1: owner (A) created full review graph under RLS (2 reviews, 3 docs, 2 quotes, 2 issues, 1 decision)'; end $$;

-- 5. Evidence-free quote_not_found issue is accepted and has NULL evidence.
do $$
declare n int;
begin
  select count(*) into n from public.issues
   where id = '00000000-0000-0000-0000-0000000000e2'
     and issue_type = 'quote_not_found' and source_document_id is null;
  if n <> 1 then raise exception 'FAIL 5: evidence-free quote_not_found issue not accepted as expected (got %)', n; end if;
  raise notice 'PASS 5: evidence-free quote_not_found issue accepted (source_document_id IS NULL)';
end $$;

-- ===========================================================================
-- Give user B some data too (so isolation is a two-way check).
-- ===========================================================================
reset role;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}', false);
set role authenticated;

insert into public.reviews (id, user_id, name) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000000b', 'Synthetic Review B1');
insert into public.documents (id, review_id, user_id, role, filename, storage_path) values
  ('00000000-0000-0000-0000-0000000000d4', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000000b', 'report', 'report-b1.md', 'b/b1/report-b1.md');

do $$ begin raise notice 'SETUP: user B created own review + document'; end $$;

-- ===========================================================================
-- 2. ISOLATION - each user sees only their own rows.
-- ===========================================================================
-- Currently acting as B:
do $$
declare n int;
begin
  select count(*) into n from public.reviews;
  if n <> 1 then raise exception 'FAIL 2 (B): expected 1 visible review, got %', n; end if;
  perform 1 from public.reviews where id = '00000000-0000-0000-0000-0000000000a1';
  if found then raise exception 'FAIL 2 (B): user B can see user A''s review'; end if;
  perform 1 from public.documents where user_id = '00000000-0000-0000-0000-00000000000a';
  if found then raise exception 'FAIL 2 (B): user B can see user A''s documents'; end if;
  raise notice 'PASS 2a: user B sees only own 1 review; A''s rows invisible';
end $$;

-- Now act as A:
reset role;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', false);
set role authenticated;
do $$
declare n int;
begin
  select count(*) into n from public.reviews;
  if n <> 2 then raise exception 'FAIL 2 (A): expected 2 visible reviews, got %', n; end if;
  perform 1 from public.reviews where id = '00000000-0000-0000-0000-0000000000b1';
  if found then raise exception 'FAIL 2 (A): user A can see user B''s review'; end if;
  raise notice 'PASS 2b: user A sees only own 2 reviews; B''s row invisible';
end $$;

-- ===========================================================================
-- 3. RLS REJECTIONS (insufficient_privilege / 42501), acting as a user.
-- ===========================================================================

-- 3a. Owner spoof: B tries to create a review owned by A  -> RLS WITH CHECK fails.
reset role;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}', false);
set role authenticated;
do $$
begin
  insert into public.reviews (user_id, name)
  values ('00000000-0000-0000-0000-00000000000a', 'Spoofed by B');
  raise exception 'FAIL 3a: B was allowed to create a review owned by A';
exception
  when insufficient_privilege then
    raise notice 'PASS 3a: B cannot create a review owned by A (RLS 42501)';
end $$;

-- 3b. Cross-user link: B tries to add a document into A''s review -> rejected
--     (RLS WITH CHECK 42501, and/or composite FK 23503).
do $$
begin
  insert into public.documents (review_id, user_id, role, filename, storage_path)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000b', 'report', 'x.md', 'b/x.md');
  raise exception 'FAIL 3b: B was allowed to link a document into A''s review';
exception
  when insufficient_privilege then
    raise notice 'PASS 3b: B cannot add a document to A''s review (RLS 42501)';
  when foreign_key_violation then
    raise notice 'PASS 3b: B cannot add a document to A''s review (composite FK 23503)';
end $$;

-- 3c. Cross-user decision: B tries to decide on A''s issue -> rejected.
do $$
begin
  insert into public.review_decisions (issue_id, user_id, decision)
  values ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-00000000000b', 'dismiss');
  raise exception 'FAIL 3c: B was allowed to record a decision on A''s issue';
exception
  when insufficient_privilege then
    raise notice 'PASS 3c: B cannot record a decision on A''s issue (RLS 42501)';
  when foreign_key_violation then
    raise notice 'PASS 3c: B cannot record a decision on A''s issue (composite FK 23503)';
end $$;

-- ===========================================================================
-- 4. STRUCTURAL REJECTIONS - composite FKs hold even when RLS is BYPASSED.
-- ===========================================================================

-- 4a. Owner mismatch, RLS BYPASSED (superuser = service-role equivalent):
--     a document whose (review_id, user_id) don't match an owned review.
reset role;                                   -- back to postgres (bypasses RLS)
select set_config('request.jwt.claims', '', false);
do $$
begin
  insert into public.documents (review_id, user_id, role, filename, storage_path)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000b', 'report', 'x.md', 'b/x.md');
  raise exception 'FAIL 4a: owner-mismatch document inserted despite composite FK (RLS bypassed)';
exception
  when foreign_key_violation then
    raise notice 'PASS 4a: owner-mismatch document rejected by composite FK even with RLS bypassed (23503)';
end $$;

-- 4b. Wrong document role: a quotation whose report_document_id points at a
--     TRANSCRIPT document -> role-checking FK rejects it. Acting as owner A
--     (RLS allows it; the FK is what stops it).
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', false);
set role authenticated;
do $$
begin
  insert into public.quotations
    (review_id, report_document_id, user_id, original_text, start_offset, end_offset, checking_result)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d2',
          '00000000-0000-0000-0000-00000000000a', 'bad role', 0, 5, 'no_issues');
  raise exception 'FAIL 4b: quotation accepted a transcript as its report document';
exception
  when foreign_key_violation then
    raise notice 'PASS 4b: quotation''s report_document_id must be a report document (role FK 23503)';
end $$;

-- 4c. Cross-review link: an issue in review A1 referencing a quotation that
--     lives in review A2 -> same-review FK rejects it. Still acting as owner A.
do $$
begin
  insert into public.issues (review_id, quotation_id, user_id, issue_type, explanation)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c2',
          '00000000-0000-0000-0000-00000000000a', 'wording_mismatch', 'cross-review');
  raise exception 'FAIL 4c: issue in A1 accepted a quotation from A2';
exception
  when foreign_key_violation then
    raise notice 'PASS 4c: issue cannot link a quotation from another review (same-review FK 23503)';
end $$;

-- ===========================================================================
-- 6. CASCADE DELETE - deleting review A1 removes its children; A2 and B survive.
-- ===========================================================================
-- Still acting as owner A.
delete from public.reviews where id = '00000000-0000-0000-0000-0000000000a1';
do $$
declare n int;
begin
  select count(*) into n from public.documents  where review_id = '00000000-0000-0000-0000-0000000000a1';
  if n <> 0 then raise exception 'FAIL 6: % A1 documents survived the cascade', n; end if;
  select count(*) into n from public.quotations where review_id = '00000000-0000-0000-0000-0000000000a1';
  if n <> 0 then raise exception 'FAIL 6: % A1 quotations survived the cascade', n; end if;
  select count(*) into n from public.issues     where review_id = '00000000-0000-0000-0000-0000000000a1';
  if n <> 0 then raise exception 'FAIL 6: % A1 issues survived the cascade', n; end if;
  select count(*) into n from public.review_decisions where issue_id = '00000000-0000-0000-0000-0000000000e1';
  if n <> 0 then raise exception 'FAIL 6: A1 decision survived the cascade'; end if;
  -- A's OTHER review (A2) must survive intact
  select count(*) into n from public.reviews    where id = '00000000-0000-0000-0000-0000000000a2';
  if n <> 1 then raise exception 'FAIL 6: user A''s other review (A2) did not survive'; end if;
  select count(*) into n from public.quotations where review_id = '00000000-0000-0000-0000-0000000000a2';
  if n <> 1 then raise exception 'FAIL 6: user A''s A2 quotation did not survive'; end if;
  raise notice 'PASS 6a: deleting A1 cascaded to its children; A''s other review A2 survived';
end $$;

-- B's data must be completely unaffected.
reset role;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}', false);
set role authenticated;
do $$
declare n int;
begin
  select count(*) into n from public.reviews;
  if n <> 1 then raise exception 'FAIL 6: user B review count changed, got %', n; end if;
  select count(*) into n from public.documents where review_id = '00000000-0000-0000-0000-0000000000b1';
  if n <> 1 then raise exception 'FAIL 6: user B document missing after A''s delete, got %', n; end if;
  raise notice 'PASS 6b: user B''s data unaffected by user A deleting a review';
end $$;

reset role;
select set_config('request.jwt.claims', '', false);

do $$ begin raise notice '================  ALL CHECKS PASSED  ================'; end $$;

-- Roll everything back: no synthetic data persists.
rollback;
