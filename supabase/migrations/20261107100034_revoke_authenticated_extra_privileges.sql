-- Migration: remove unneeded extra privileges from `authenticated`.
-- Created: 2026-11-07
--
-- WHY
-- The app's signed-in workflow needs only SELECT, INSERT, UPDATE, DELETE on the
-- five application tables (row access is then restricted by owner-only RLS).
-- However, `authenticated` currently holds GRANT ALL, i.e. four EXTRA privileges
-- it does not use:
--   * TRUNCATE  - destructive: empties a table outright, and (unlike DELETE) is
--                 NOT filtered by Row Level Security.
--   * REFERENCES - create foreign keys against these tables.
--   * TRIGGER    - create triggers on these tables.
--   * MAINTAIN   - run maintenance (VACUUM/ANALYZE/REINDEX/etc.).
-- These came from a Supabase platform-default grant (the four extras) combined
-- with our earlier data-privilege grant, adding up to ALL. This migration revokes
-- exactly those four extras.
--
-- SCOPE
--   * Revokes only TRUNCATE, REFERENCES, TRIGGER, MAINTAIN from `authenticated`.
--   * PRESERVES SELECT, INSERT, UPDATE, DELETE for `authenticated`.
--   * Leaves owner-only RLS unchanged.
--   * Does not touch `anon` (already has no table privileges) or `service_role`.

revoke trigger, references, truncate, maintain on
  public.reviews,
  public.documents,
  public.quotations,
  public.issues,
  public.review_decisions
from authenticated;
