-- Migration: quotation match evidence + results-recording function
-- Created: 2026-11-10
--
-- Supports the first quotation check (checklist item 9). A quotation's wording is
-- searched for in the transcripts; when it is found in confirmed-participant
-- speech we record WHERE it was found. The existing `quotations` table stores the
-- report-side quote and a no_issues/has_issues result, but has nowhere to record
-- the matching transcript evidence, so we add it here.
--
-- Design decisions (see docs/adr/0005 and the agreed plan):
--   * Evidence is the matched TRANSCRIPT document + the whole participant line.
--     No transcript offsets in this step.
--   * A wording match is `checking_result = 'no_issues'` WITH evidence. An
--     unmatched quote is `has_issues` (with a `quote_not_found` issue) and carries
--     NO evidence -- it is never recorded as verified.
--   * `has_issues` is ALLOWED to carry evidence too, for a later participant
--     mismatch (the issue PLUS the supporting transcript passage).

-- ---------------------------------------------------------------------------
-- 1. Match-evidence columns on quotations.
-- ---------------------------------------------------------------------------
alter table public.quotations
  add column matched_document_id uuid,
  -- fixed-value column pinned to 'transcript'; part of the role-checking FK below
  add column matched_role text not null default 'transcript'
    check (matched_role = 'transcript'),
  add column matched_excerpt text;

-- matched_document_id, when present, must be a 'transcript' in the SAME review.
-- NULL matched_document_id disables the FK (MATCH SIMPLE) -> an evidence-free row.
alter table public.quotations
  add constraint quotations_matched_document_fk
  foreign key (matched_document_id, review_id, matched_role)
  references public.documents (id, review_id, role) on delete cascade;

-- Evidence is all-or-nothing: the matched document and excerpt are present
-- together or absent together.
alter table public.quotations
  add constraint quotations_match_evidence_paired
  check ((matched_document_id is null) = (matched_excerpt is null));

-- A wording-matched ('no_issues') quotation MUST carry evidence, so an unmatched
-- quote can never be stored as verified. 'has_issues' MAY carry evidence too.
alter table public.quotations
  add constraint quotations_no_issues_requires_match
  check (checking_result <> 'no_issues' or matched_document_id is not null);

create index quotations_matched_document_id_idx
  on public.quotations (matched_document_id);

-- ---------------------------------------------------------------------------
-- 2. record_quotation_results(review_id, results)
--
-- Atomically replaces a review's quotation results. `results` is a JSON array;
-- each element is one quotation:
--   {
--     "report_document_id": uuid,          -- the report the quote came from
--     "original_text":      text,
--     "listed_participant_id": text|null,  -- report attribution, or null
--     "start_offset": int, "end_offset": int,   -- code-point offsets in report
--     "checking_result": "no_issues"|"has_issues",
--     "matched_document_id": uuid|null,    -- the transcript it matched, or null
--     "matched_excerpt":    text|null,     -- the whole participant line, or null
--     "issues": [ { "issue_type": text, "explanation": text|null } ]  -- optional
--   }
-- The database CHECK constraints and composite FKs above are the real guardrails;
-- this function just records what the app computed, as the signed-in user.
-- ---------------------------------------------------------------------------
create or replace function public.record_quotation_results(
  p_review_id uuid,
  p_results jsonb
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_quotation jsonb;
  v_issue jsonb;
  v_quotation_id uuid;
  v_count integer := 0;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;

  -- Replace any prior results for this review (cascades to their issues).
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
        review_id, quotation_id, user_id, issue_type, explanation
      )
      values (
        p_review_id,
        v_quotation_id,
        v_user_id,
        v_issue->>'issue_type',
        v_issue->>'explanation'
      );
    end loop;

    v_count := v_count + 1;
  end loop;

  update public.reviews
     set processing_status = 'complete'
   where id = p_review_id;

  return v_count;
end;
$$;

revoke all on function public.record_quotation_results(uuid, jsonb) from public, anon;
grant execute on function public.record_quotation_results(uuid, jsonb) to authenticated;
