-- Migration: private Storage bucket for uploaded .md files + owner-only policies
-- Created: 2026-11-10
--
-- The file BYTES for a review (the report and transcripts) live in Supabase
-- Storage, not in the database; docs/architecture.md requires them to be in a
-- PRIVATE bucket (never public). This migration creates that bucket and the Row
-- Level Security policies that fence each signed-in researcher to their OWN
-- files.
--
-- Access model (mirrors the owner-only RLS already on the application tables):
--   * Bucket `review-files` is PRIVATE (public = false): no public URLs, and with
--     RLS the default is deny -- nothing is readable or writable without a policy.
--   * Every file is stored under a path whose FIRST folder is the uploader's user
--     id:  {user_id}/{review_id}/{filename}.  The first folder is
--     (storage.foldername(name))[1].
--   * Three policies allow an `authenticated` user to act only on objects in this
--     bucket whose first folder equals their own auth.uid(): INSERT uses WITH
--     CHECK (the row being written); SELECT and DELETE use USING (the row being
--     read/removed). There is deliberately NO UPDATE policy: this workflow only
--     uploads new files, reads them, and deletes them -- it never moves, renames,
--     or overwrites a file. With RLS default-deny, every UPDATE is therefore
--     refused for everyone (including any attempt to move a file into another
--     user's folder), so no move/rename/overwrite surface is exposed.
--
-- auth.uid() is a uuid; the folder segment is text, so it is compared as
-- auth.uid()::text. The app runs as the signed-in user (publishable key); the
-- service-role key, which bypasses these policies, is never used by the app.
--
-- storage.objects already has RLS enabled on Supabase; we only add policies.

-- ---------------------------------------------------------------------------
-- 1. The private bucket.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('review-files', 'review-files', false)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Owner-only policies on storage.objects, scoped to this bucket.
-- ---------------------------------------------------------------------------

-- Read only your own files.
create policy "review_files_owner_select"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'review-files'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

-- Upload only into your own folder.
create policy "review_files_owner_insert"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'review-files'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

-- (No UPDATE policy on purpose -- see the header note. Moving, renaming, and
-- overwriting are not part of this workflow, so every UPDATE stays denied.)

-- Delete only your own files.
create policy "review_files_owner_delete"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'review-files'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );
