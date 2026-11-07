-- =============================================================================
-- Test for migration 20261107100034_revoke_authenticated_extra_privileges.sql:
-- after the revoke, `authenticated` holds EXACTLY SELECT, INSERT, UPDATE, DELETE
-- on all five application tables - no TRUNCATE/REFERENCES/TRIGGER/MAINTAIN - and
-- owner-only RLS is still enabled on every table.
--
-- Self-contained: it performs the same revoke the migration does, inside a
-- transaction that ends in ROLLBACK, so it is safe to re-run and leaves the DB
-- unchanged. Local only. Reads the privilege / RLS catalogs; touches no data.
--
-- HOW TO RUN: see supabase/tests/README.md.
-- Clean run prints PASS lines and ALL CHECKS PASSED (psql exit 0); a failure
-- RAISEs and aborts (exit 3).
-- =============================================================================

\set ON_ERROR_STOP on

begin;

-- Baseline (informational): what does authenticated hold now?
do $$
declare v text;
begin
  select string_agg(distinct privilege_type, ',' order by privilege_type) into v
    from information_schema.role_table_grants
   where grantee = 'authenticated' and table_schema = 'public'
     and table_name in ('reviews','documents','quotations','issues','review_decisions');
  raise notice 'BASELINE: authenticated privilege types before revoke: %', v;
end $$;

-- Apply the same revoke as migration 20261107100034 (kept in sync with it).
revoke trigger, references, truncate, maintain on
  public.reviews, public.documents, public.quotations, public.issues, public.review_decisions
from authenticated;

do $$
declare
  t text;
  got text;
  extras int;
begin
  foreach t in array array['reviews','documents','quotations','issues','review_decisions']
  loop
    -- authenticated must have EXACTLY the four data privileges on this table.
    select string_agg(privilege_type, ',' order by privilege_type) into got
      from information_schema.role_table_grants
     where grantee = 'authenticated' and table_schema = 'public' and table_name = t;
    if got is distinct from 'DELETE,INSERT,SELECT,UPDATE' then
      raise exception 'FAIL: authenticated on % has [%], expected exactly DELETE,INSERT,SELECT,UPDATE', t, got;
    end if;

    -- Belt-and-suspenders: none of the four extras remain (via any path).
    select count(*) into extras
      from (values ('TRUNCATE'),('REFERENCES'),('TRIGGER'),('MAINTAIN')) as e(priv)
     where has_table_privilege('authenticated', format('public.%I', t), e.priv);
    if extras <> 0 then
      raise exception 'FAIL: authenticated still effectively has % extra privilege(s) on %', extras, t;
    end if;

    -- RLS must still be enabled on this table.
    if not (select relrowsecurity from pg_class where oid = format('public.%I', t)::regclass) then
      raise exception 'FAIL: RLS is no longer enabled on %', t;
    end if;
  end loop;

  raise notice 'PASS: authenticated has exactly SELECT/INSERT/UPDATE/DELETE on all 5 tables';
  raise notice 'PASS: no TRUNCATE/REFERENCES/TRIGGER/MAINTAIN remain for authenticated';
  raise notice 'PASS: owner-only RLS still enabled on all 5 tables';
end $$;

do $$ begin raise notice '======  REVOKE AUTHENTICATED EXTRAS TEST: ALL CHECKS PASSED  ======'; end $$;

rollback;
