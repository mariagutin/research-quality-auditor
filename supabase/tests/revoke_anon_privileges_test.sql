-- =============================================================================
-- Test for migration 20261106120000_revoke_anon_table_privileges.sql:
-- after the revoke, `anon` has NO privileges on any application table, while
-- `authenticated` keeps its SELECT/INSERT/UPDATE/DELETE access.
--
-- Self-contained: it performs the same revoke the migration does, inside a
-- transaction that ends in ROLLBACK, so it is safe to re-run and leaves the DB
-- unchanged. Local only. Reads the privilege catalog (information_schema); it
-- does not touch any data.
--
-- HOW TO RUN: see supabase/tests/README.md.
-- Clean run prints PASS lines and ALL CHECKS PASSED (psql exit 0); a failure
-- RAISEs and aborts (exit 3).
-- =============================================================================

\set ON_ERROR_STOP on

begin;

-- Baseline (informational): how many privilege rows does anon hold on the five
-- app tables right now?
do $$
declare n int;
begin
  select count(*) into n from information_schema.role_table_grants
   where grantee = 'anon' and table_schema = 'public'
     and table_name in ('reviews','documents','quotations','issues','review_decisions');
  raise notice 'BASELINE: anon holds % privilege row(s) on the 5 app tables before revoke', n;
end $$;

-- Apply the same revoke as migration 20261106120000 (kept in sync with it).
revoke all on
  public.reviews, public.documents, public.quotations, public.issues, public.review_decisions
from anon;

do $$
declare n int;
begin
  -- anon must have ZERO privileges on all five tables now.
  select count(*) into n from information_schema.role_table_grants
   where grantee = 'anon' and table_schema = 'public'
     and table_name in ('reviews','documents','quotations','issues','review_decisions');
  if n <> 0 then
    raise exception 'FAIL: anon still holds % privilege row(s) on app tables after revoke', n;
  end if;
  raise notice 'PASS: anon has no privileges on any of the 5 app tables after revoke';

  -- authenticated must KEEP SELECT/INSERT/UPDATE/DELETE on all five tables
  -- (4 privileges x 5 tables = 20 rows).
  select count(*) into n from information_schema.role_table_grants
   where grantee = 'authenticated' and table_schema = 'public'
     and table_name in ('reviews','documents','quotations','issues','review_decisions')
     and privilege_type in ('SELECT','INSERT','UPDATE','DELETE');
  if n <> 20 then
    raise exception 'FAIL: authenticated should keep 20 data-privilege rows (4 x 5), got %', n;
  end if;
  raise notice 'PASS: authenticated still has SELECT/INSERT/UPDATE/DELETE on all 5 tables';
end $$;

do $$ begin raise notice '==========  REVOKE ANON PRIVILEGES TEST: ALL CHECKS PASSED  =========='; end $$;

rollback;
