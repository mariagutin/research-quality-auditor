-- Migration: explicit Data API privileges for the signed-in-user workflow.
-- Created: 2026-11-06
--
-- WHY THIS EXISTS
-- Hosted Supabase projects with "Automatically expose new tables" (a.k.a.
-- "Default privileges for new entities") DISABLED do not auto-grant table
-- privileges to the API roles. In PostgreSQL, table privileges (GRANT) are
-- checked BEFORE Row Level Security, so without an explicit grant a signed-in
-- (`authenticated`) user gets "permission denied" (42501) even on their OWN
-- rows. The initial migration (20261105000000) enables owner-only RLS but does
-- not grant table access, so it relied on automatic grants. This migration adds
-- the missing grants explicitly.
--
-- WHAT IT DOES
--   * Grants USAGE on schema public to `authenticated` (needed to resolve the
--     tables at all).
--   * Grants SELECT, INSERT, UPDATE, DELETE on the five application tables to
--     `authenticated`.
--
-- WHAT IT DELIBERATELY DOES NOT DO
--   * No access is granted to `anon` (the workflow is signed-in only).
--   * The owner-only RLS policies from 20261105000000 are left untouched. Grants
--     decide whether a role may touch a table; RLS still decides WHICH ROWS it
--     sees. Together: an authenticated user can reach these tables but only
--     their own rows.
--   * No sequence or function grants are needed: primary keys use
--     gen_random_uuid() (no sequences), and firing the updated_at triggers does
--     not require the EXECUTE/TRIGGER privilege for the acting user.

grant usage on schema public to authenticated;

grant select, insert, update, delete on
  public.reviews,
  public.documents,
  public.quotations,
  public.issues,
  public.review_decisions
to authenticated;
