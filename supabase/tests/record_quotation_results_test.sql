-- =============================================================================
-- Synthetic test for the quotation match-evidence schema + the
-- public.record_quotation_results(...) function
-- (migration 20261110120000_add_quotation_match_evidence.sql).
--
-- WHAT THIS CHECKS, as one synthetic signed-in user:
--   1. Recording results — a run with one wording-matched quote and one
--      unmatched quote inserts both, attaches a `quote_not_found` issue to the
--      unmatched one, sets the review to `complete`, and returns the count.
--   2. Re-run replaces — a second run clears the prior results first.
--   3. Constraints / FK (direct inserts that must be rejected or allowed):
--      a. `no_issues` with NO evidence            -> rejected (CHECK).
--      b. matched document without excerpt (unpaired) -> rejected (CHECK).
--      c. `has_issues` WITH evidence              -> ALLOWED (future mismatch).
--      d. evidence pointing at a REPORT document  -> rejected (role FK).
--      e. evidence pointing at another review's transcript -> rejected (FK).
--
-- SAFETY: synthetic data only; one transaction that ends in ROLLBACK; local,
-- disposable Supabase only — never hosted.
--
-- HOW TO RUN (see supabase/tests/README.md):
--   docker exec -i supabase_db_research-quality-auditor \
--     psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--     -f - < supabase/tests/record_quotation_results_test.sql
-- =============================================================================

\set ON_ERROR_STOP on

begin;

-- One synthetic user; two reviews; a report + transcript in R1; a transcript in R2.
insert into auth.users (instance_id, id, aud, role, email) values
  ('00000000-0000-0000-0000-000000000000',
   '00000000-0000-0000-0000-00000000000a',
   'authenticated', 'authenticated', 'anna@synthetic.test');

select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', false);
set role authenticated;

insert into public.reviews (id, user_id, name) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-00000000000a', 'Review 1'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-00000000000a', 'Review 2');

insert into public.documents (id, review_id, user_id, role, filename, storage_path, participant_id) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-00000000000a', 'report',     'report.md', 'a/r1/report.md', null),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-00000000000a', 'transcript', 'p03.md',    'a/r1/p03.md',    'P03'),
  ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-00000000000a', 'transcript', 'p05.md',    'a/r2/p05.md',    'P05');

do $$ begin raise notice 'SETUP: user, 2 reviews, report+transcript (R1), transcript (R2)'; end $$;

-- ===========================================================================
-- 1. Recording: one wording-matched quote + one unmatched quote.
-- ===========================================================================
do $$
declare
  v_ret integer;
  v_qid uuid;
  r text;
  mdoc uuid;
  mexc text;
  pid text;
  n int;
begin
  select public.record_quotation_results(
    '00000000-0000-0000-0000-0000000000f1',
    jsonb_build_array(
      jsonb_build_object(
        'report_document_id', '00000000-0000-0000-0000-0000000000d1',
        'original_text', 'I loved how simple the setup was.',
        'listed_participant_id', 'P03',
        'start_offset', 0, 'end_offset', 33,
        'checking_result', 'no_issues',
        'matched_document_id', '00000000-0000-0000-0000-0000000000d2',
        'matched_excerpt', 'P03: I loved how simple the setup was.'
      ),
      jsonb_build_object(
        'report_document_id', '00000000-0000-0000-0000-0000000000d1',
        'original_text', 'A quote that is not in any transcript.',
        'listed_participant_id', null,
        'start_offset', 40, 'end_offset', 78,
        'checking_result', 'has_issues',
        'matched_document_id', null,
        'matched_excerpt', null,
        'issues', jsonb_build_array(
          jsonb_build_object('issue_type', 'quote_not_found',
                             'explanation', 'Quote not located in any transcript.')
        )
      )
    )
  ) into v_ret;

  if v_ret <> 2 then raise exception 'FAIL 1: expected 2 recorded, got %', v_ret; end if;

  select count(*) into n from public.quotations where review_id = '00000000-0000-0000-0000-0000000000f1';
  if n <> 2 then raise exception 'FAIL 1: expected 2 quotations, got %', n; end if;

  -- The wording-matched quote.
  select checking_result, matched_document_id, matched_excerpt, listed_participant_id
    into r, mdoc, mexc, pid
    from public.quotations
    where review_id = '00000000-0000-0000-0000-0000000000f1'
      and original_text = 'I loved how simple the setup was.';
  if r <> 'no_issues' then raise exception 'FAIL 1: matched quote should be no_issues, got %', r; end if;
  if mdoc <> '00000000-0000-0000-0000-0000000000d2' then raise exception 'FAIL 1: wrong matched_document_id %', mdoc; end if;
  if mexc is null then raise exception 'FAIL 1: matched_excerpt should be set'; end if;
  if pid <> 'P03' then raise exception 'FAIL 1: listed_participant_id should be P03, got %', pid; end if;

  -- The unmatched quote + its issue.
  select id, checking_result, matched_document_id, listed_participant_id
    into v_qid, r, mdoc, pid
    from public.quotations
    where review_id = '00000000-0000-0000-0000-0000000000f1'
      and original_text = 'A quote that is not in any transcript.';
  if r <> 'has_issues' then raise exception 'FAIL 1: unmatched quote should be has_issues, got %', r; end if;
  if mdoc is not null then raise exception 'FAIL 1: unmatched quote should have no evidence'; end if;
  if pid is not null then raise exception 'FAIL 1: unmatched quote participant id should be empty'; end if;

  select count(*) into n from public.issues
    where quotation_id = v_qid and issue_type = 'quote_not_found';
  if n <> 1 then raise exception 'FAIL 1: expected 1 quote_not_found issue, got %', n; end if;

  -- Review marked complete.
  select processing_status into r from public.reviews where id = '00000000-0000-0000-0000-0000000000f1';
  if r <> 'complete' then raise exception 'FAIL 1: review should be complete, got %', r; end if;

  raise notice 'PASS 1: recorded 1 wording match (no_issues + evidence + P03) and 1 unmatched (has_issues + quote_not_found); review complete';
end $$;

-- ===========================================================================
-- 2. Re-run replaces prior results.
-- ===========================================================================
do $$
declare v_ret integer; n int;
begin
  select public.record_quotation_results(
    '00000000-0000-0000-0000-0000000000f1',
    jsonb_build_array(
      jsonb_build_object(
        'report_document_id', '00000000-0000-0000-0000-0000000000d1',
        'original_text', 'I loved how simple the setup was.',
        'listed_participant_id', 'P03',
        'start_offset', 0, 'end_offset', 33,
        'checking_result', 'no_issues',
        'matched_document_id', '00000000-0000-0000-0000-0000000000d2',
        'matched_excerpt', 'P03: I loved how simple the setup was.'
      )
    )
  ) into v_ret;
  if v_ret <> 1 then raise exception 'FAIL 2: expected 1 recorded, got %', v_ret; end if;

  select count(*) into n from public.quotations where review_id = '00000000-0000-0000-0000-0000000000f1';
  if n <> 1 then raise exception 'FAIL 2: re-run should leave 1 quotation, got %', n; end if;
  select count(*) into n from public.issues where review_id = '00000000-0000-0000-0000-0000000000f1';
  if n <> 0 then raise exception 'FAIL 2: re-run should clear prior issues, got %', n; end if;

  raise notice 'PASS 2: re-run cleared prior results (1 quotation, 0 issues remain)';
end $$;

-- ===========================================================================
-- 3. Constraints + FK via direct inserts.
-- ===========================================================================

-- 3a. no_issues with NO evidence -> CHECK (quotations_no_issues_requires_match).
do $$
declare v_raised boolean := false; v_state text;
begin
  begin
    insert into public.quotations
      (review_id, report_document_id, user_id, original_text, start_offset, end_offset, checking_result)
    values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000d1',
            '00000000-0000-0000-0000-00000000000a', 'x', 0, 1, 'no_issues');
  exception when check_violation then v_raised := true;
  end;
  if not v_raised then raise exception 'FAIL 3a: no_issues without evidence was allowed'; end if;
  raise notice 'PASS 3a: no_issues without evidence rejected (CHECK)';
end $$;

-- 3b. matched document but no excerpt (unpaired) -> CHECK (paired).
do $$
declare v_raised boolean := false;
begin
  begin
    insert into public.quotations
      (review_id, report_document_id, user_id, original_text, start_offset, end_offset,
       checking_result, matched_document_id, matched_excerpt)
    values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000d1',
            '00000000-0000-0000-0000-00000000000a', 'x', 0, 1, 'has_issues',
            '00000000-0000-0000-0000-0000000000d2', null);
  exception when check_violation then v_raised := true;
  end;
  if not v_raised then raise exception 'FAIL 3b: unpaired evidence (doc without excerpt) was allowed'; end if;
  raise notice 'PASS 3b: unpaired evidence rejected (CHECK)';
end $$;

-- 3c. has_issues WITH evidence -> ALLOWED (future participant mismatch).
do $$
declare n int;
begin
  insert into public.quotations
    (review_id, report_document_id, user_id, original_text, start_offset, end_offset,
     checking_result, matched_document_id, matched_excerpt)
  values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000d1',
          '00000000-0000-0000-0000-00000000000a', 'mismatch example', 0, 1, 'has_issues',
          '00000000-0000-0000-0000-0000000000d2', 'P03: mismatch example');
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL 3c: has_issues WITH evidence was not inserted'; end if;
  raise notice 'PASS 3c: has_issues WITH evidence allowed';
end $$;

-- 3d. evidence pointing at a REPORT document -> role FK rejects it.
do $$
declare v_raised boolean := false;
begin
  begin
    insert into public.quotations
      (review_id, report_document_id, user_id, original_text, start_offset, end_offset,
       checking_result, matched_document_id, matched_excerpt)
    values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000d1',
            '00000000-0000-0000-0000-00000000000a', 'x', 0, 1, 'has_issues',
            '00000000-0000-0000-0000-0000000000d1', 'not a transcript'); -- d1 is the REPORT
  exception when foreign_key_violation then v_raised := true;
  end;
  if not v_raised then raise exception 'FAIL 3d: evidence pointing at a report document was allowed'; end if;
  raise notice 'PASS 3d: evidence must be a transcript, not a report (role FK)';
end $$;

-- 3e. evidence pointing at another review's transcript -> FK rejects it.
do $$
declare v_raised boolean := false;
begin
  begin
    insert into public.quotations
      (review_id, report_document_id, user_id, original_text, start_offset, end_offset,
       checking_result, matched_document_id, matched_excerpt)
    values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000d1',
            '00000000-0000-0000-0000-00000000000a', 'x', 0, 1, 'has_issues',
            '00000000-0000-0000-0000-0000000000d3', 'P05: from another review'); -- d3 is in R2
  exception when foreign_key_violation then v_raised := true;
  end;
  if not v_raised then raise exception 'FAIL 3e: evidence from another review was allowed'; end if;
  raise notice 'PASS 3e: evidence must be in the same review (FK)';
end $$;

reset role;
select set_config('request.jwt.claims', '', false);

do $$ begin raise notice '================  ALL CHECKS PASSED  ================'; end $$;

rollback;
