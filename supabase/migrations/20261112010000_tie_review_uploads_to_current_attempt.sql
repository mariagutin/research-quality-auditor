-- Migration: tie review-file uploads to the current upload attempt
-- Created: 2026-11-12
--
-- Tightens the `review-files` INSERT policy so a PUT is authorized ONLY when it
-- targets the CURRENT upload attempt of an owning review that is `uploading`.
-- Path convention (review-row-first + per-attempt token):
--     {user_id}/{review_id}/{op_token}/{filename}
-- i.e. (storage.foldername(name)) = { user_id, review_id, op_token }.
--
-- With this, a PUT is rejected when:
--   * the review is not `uploading` (draft/processing/complete/deleting) -> no
--     "additional" uploads after the upload window, and no uploads once deletion
--     has started;
--   * the token segment is not the review's CURRENT op_token -> a retired/stale
--     attempt (e.g. the superseded /T1/ after a retry to /T2/) cannot add files;
--   * the review no longer exists (deleted) -> EXISTS is false, and review ids are
--     never reused, so a deleted review's prefix can never be written to again;
--   * the attempt is CONFIRMED failed (op_failed_at set) -> no late success;
--   * the first folder is not the caller's own user id -> cross-user upload.
--
-- Compared via ::text so a malformed path segment simply fails to match (it never
-- raises a cast error). SELECT and DELETE policies are deliberately UNCHANGED
-- (owner-folder only), so an owner can still LIST and REMOVE files AFTER the review
-- row is gone -- which every cleanup path relies on.
--
-- WHAT THIS DOES NOT DO: this is an authorization predicate on the storage.objects
-- INSERT. It does not, by itself, cancel an upload request that was already
-- accepted and is still transferring; that case is handled by the cleanup design
-- (durable records + convention sweeps), which needs the real upload/delete paths
-- to exercise. See docs/adr/0008-*.
--
-- TEMPORARY APP INCOMPATIBILITY (intended): the current app uploads to
-- {uid}/{reviewId}/{filename} (no token segment) and creates the review row LAST,
-- so under this policy those PUTs are REJECTED. Uploads work again only after the
-- app-wiring phase (begin_upload first; upload under the token path). This is
-- expected; see docs/adr/0008 and the app-wiring notes.
--
-- Local/disposable Supabase only until explicitly authorized for hosted.

drop policy "review_files_owner_insert" on storage.objects;

create policy "review_files_owner_insert"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'review-files'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
    and exists (
      -- NOTE: qualify the object path as objects.name. `reviews` also has a `name`
      -- column, so an unqualified name here would bind to the review's display
      -- name, not the Storage object path.
      select 1
      from public.reviews r
      where r.id::text = (storage.foldername(objects.name))[2]
        and r.user_id = (select auth.uid())
        and r.processing_status = 'uploading'
        and r.op_failed_at is null
        and r.op_token::text = (storage.foldername(objects.name))[3]
    )
  );
