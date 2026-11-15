-- Migration: review_op_active -- is a review's current operation ACTIVE?
-- Created: 2026-11-12
--
-- Read-only helper for the UI to distinguish an ACTIVE busy operation from a
-- RECOVERABLE one (confirmed-failed or stale), judged with DATABASE time. The UI
-- uses it to disable Delete only while an upload/check is active, and to enable
-- Retry delete only once a deletion has failed or stalled -- so an interrupted
-- operation never leaves Delete (or Retry) permanently disabled.
--
-- ACTIVE := processing_status in (uploading,processing,deleting)
--           AND op_failed_at IS NULL
--           AND op_heartbeat_at > now() - 2 minutes   (same window as begin_review_op).
--
-- Returns false for a review that is not the caller's, does not exist, is idle
-- (draft/complete/failed), confirmed-failed, or stale. SECURITY INVOKER + the
-- explicit owner check, so RLS applies and only the owner sees their own.

create function public.review_op_active(p_review_id uuid)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  select coalesce((
    select r.processing_status in ('uploading', 'processing', 'deleting')
       and r.op_failed_at is null
       and r.op_heartbeat_at is not null
       and r.op_heartbeat_at > now() - interval '2 minutes'
    from public.reviews r
    where r.id = p_review_id and r.user_id = (select auth.uid())
  ), false);
$$;

revoke all on function public.review_op_active(uuid) from public, anon;
grant execute on function public.review_op_active(uuid) to authenticated;
