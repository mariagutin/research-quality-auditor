-- Migration: atomic creation of a review and its document rows
-- Created: 2026-11-09
--
-- Supports the upload-confirmation step of MVP #1 (checklist item 9). The app
-- uploads the .md files to the private Storage bucket FIRST, then calls this
-- function as the LAST step to create the `reviews` row and its `documents` rows
-- together, in a single transaction. Either every row is created or none is, so a
-- partially-saved set can never appear as a saved review.
--
-- The caller (the app) passes the review id it generated, so (a) the Storage
-- paths it already wrote match this id, and (b) a save that TIMES OUT can be
-- verified afterwards by looking up this exact id before any uploaded file is
-- deleted.
--
-- Rules enforced here (all inside the transaction, so a violation writes nothing):
--   * exactly one `report` document;
--   * at least one `transcript` document;
--   * every `transcript` arrives with a confirmed, non-blank participant id
--     (participant ids are confirmed before the save) -- it is stored trimmed.
--   * the report's participant id is left NULL (the app sends none).
--
-- Security: SECURITY INVOKER (runs as the signed-in user), so owner-only RLS
-- applies and auth.uid() is that user. user_id is taken from auth.uid() itself --
-- a caller cannot set it. No service-role key is involved. search_path is pinned
-- empty, so every reference is schema-qualified.

create or replace function public.create_review_with_documents(
  p_review_id uuid,
  p_name text,
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
    raise exception 'not authenticated';
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
    select 1
    from jsonb_array_elements(p_documents) as d
    where d->>'role' = 'transcript'
      and nullif(btrim(d->>'participant_id'), '') is null
  ) then
    raise exception 'each transcript must have a confirmed participant id';
  end if;

  insert into public.reviews (id, user_id, name)
  values (p_review_id, v_user_id, p_name)
  returning * into v_review;

  insert into public.documents
    (review_id, user_id, role, filename, storage_path, participant_id)
  select
    p_review_id,
    v_user_id,
    d->>'role',
    d->>'filename',
    d->>'storage_path',
    nullif(btrim(d->>'participant_id'), '')
  from jsonb_array_elements(p_documents) as d;

  return v_review;
end;
$$;

-- Least privilege: only signed-in users may call it; anon and PUBLIC may not.
revoke all on function public.create_review_with_documents(uuid, text, jsonb) from public, anon;
grant execute on function public.create_review_with_documents(uuid, text, jsonb) to authenticated;
