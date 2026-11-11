-- Migration: record issue source evidence in record_quotation_results
-- Created: 2026-11-11
--
-- Extends public.record_quotation_results so each issue in the results can carry
-- `source_document_id` (the supporting transcript) and `source_excerpt` (the
-- verbatim passage). Used by participant attribution verification: when the
-- report attributes a quote to one participant but it was said by another, the
-- `participant_mismatch` issue points at that other transcript + line, kept
-- consistent with the quotation's matched_* evidence.
--
-- Issues with no evidence (e.g. quote_not_found) leave both NULL, which disables
-- the role-checking FK (issues_source_document_fk is MATCH SIMPLE). `source_role`
-- keeps its 'transcript' default, so any non-NULL source must be a transcript in
-- the same review.
--
-- CREATE OR REPLACE preserves the function's existing grants (EXECUTE to
-- authenticated; revoked from public/anon) from migration 20261110120000.

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
     set processing_status = 'complete'
   where id = p_review_id;

  return v_count;
end;
$$;
