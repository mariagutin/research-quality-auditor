-- Migration: remove unused `anon` privileges from the application tables.
-- Created: 2026-11-06
--
-- WHY
-- This app is signed-in only. `anon` already has no row-level data access
-- (no SELECT, INSERT, UPDATE or DELETE). What remains on `anon` are
-- platform-default privileges the app never uses: REFERENCES, TRIGGER, MAINTAIN,
-- and TRUNCATE. Note that TRUNCATE is NOT a harmless non-data privilege: it
-- empties a table outright and, unlike DELETE, is not filtered by Row Level
-- Security. It is not currently reachable through the Data API, but removing it
-- (and the others) from `anon` is a genuine least-privilege / defense-in-depth
-- improvement, not merely cosmetic.
--
-- SCOPE
--   * Revokes ALL privileges on the five application tables from `anon` only.
--   * Leaves `authenticated` and `service_role` untouched.
--   * Leaves owner-only RLS unchanged.
--   * Leaves `GRANT USAGE ON SCHEMA public` as-is: schema usage alone grants no
--     access to any table, so it is harmless and out of scope here.

revoke all on
  public.reviews,
  public.documents,
  public.quotations,
  public.issues,
  public.review_decisions
from anon;
