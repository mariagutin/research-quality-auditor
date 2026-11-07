-- =============================================================================
-- Data API grants test - proves migration 20261106000000 lets signed-in users
-- reach their own rows WITHOUT relying on Supabase's automatic table grants,
-- while owner-only RLS still isolates users and anon gets nothing.
--
-- WHY A SEPARATE TEST
-- On a hosted project with "Automatically expose new tables" DISABLED, a new
-- table has NO privileges for the API roles. A local `supabase start` stack
-- auto-grants them, so to reproduce the hosted condition this test REVOKES those
-- auto-grants inside a transaction, then applies the exact grants from migration
-- 20261106000000, and checks the workflow. Everything is rolled back at the end,
-- so it is self-cleaning and safe to re-run. Synthetic data only; local only.
--
-- HOW TO RUN: see supabase/tests/README.md.
-- A clean run prints PASS lines and ends with ALL CHECKS PASSED (psql exit 0);
-- a failure RAISEs and aborts (exit 3). Either way, nothing persists.
-- =============================================================================

\set ON_ERROR_STOP on

begin;

-- ---------------------------------------------------------------------------
-- Setup (as superuser; bypasses RLS and needs no grants): two users, each with
-- one review of their own.
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email) values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000000a', 'authenticated', 'authenticated', 'grants-a@synthetic.test'),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000000b', 'authenticated', 'authenticated', 'grants-b@synthetic.test');

insert into public.reviews (id, user_id, name) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000a', 'Grants Review A'),
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000000b', 'Grants Review B');

do $$ begin raise notice 'SETUP: 2 synthetic users, each with one review'; end $$;

-- ---------------------------------------------------------------------------
-- Simulate "Automatically expose new tables" = DISABLED on hosted: strip the
-- privileges a local stack auto-grants, so the tables look like freshly created
-- hosted tables with nothing granted yet (and also removes this migration's
-- grants so the next step genuinely re-applies them).
-- ---------------------------------------------------------------------------
revoke all on public.reviews, public.documents, public.quotations, public.issues, public.review_decisions
  from anon, authenticated;
revoke usage on schema public from anon, authenticated;

-- Negative control: with grants disabled, even the OWNER cannot read own rows.
-- This proves the grant is genuinely required (RLS alone is not enough).
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', false);
set role authenticated;
do $$
begin
  perform 1 from public.reviews where id = '00000000-0000-0000-0000-0000000000a1';
  raise exception 'FAIL (control): owner read succeeded with grants disabled - test is not really simulating the hosted condition';
exception
  when insufficient_privilege then
    raise notice 'PASS (control): with grants disabled, the owner is blocked (42501) - an explicit grant IS required';
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- Apply the grants from migration 20261106000000 (kept in sync with that file).
-- ---------------------------------------------------------------------------
grant usage on schema public to authenticated;
grant select, insert, update, delete on
  public.reviews, public.documents, public.quotations, public.issues, public.review_decisions
  to authenticated;
do $$ begin raise notice 'APPLIED: migration 20261106000000 grants (usage + SELECT/INSERT/UPDATE/DELETE to authenticated)'; end $$;

-- ---------------------------------------------------------------------------
-- Owner A can now reach OWN records (read, insert, update, delete), and RLS
-- still hides user B's records.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', false);
set role authenticated;
do $$
declare n int;
begin
  -- READ own
  select count(*) into n from public.reviews where id = '00000000-0000-0000-0000-0000000000a1';
  if n <> 1 then raise exception 'FAIL: owner cannot read own review after grant (got %)', n; end if;
  -- INSERT own child
  insert into public.documents (review_id, user_id, role, filename, storage_path)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000a', 'report', 'r.md', 'a/a1/r.md');
  -- UPDATE own
  update public.reviews set name = 'Grants Review A (edited)' where id = '00000000-0000-0000-0000-0000000000a1';
  if not found then raise exception 'FAIL: owner cannot update own review after grant'; end if;
  -- DELETE own child
  delete from public.documents where review_id = '00000000-0000-0000-0000-0000000000a1';
  if not found then raise exception 'FAIL: owner cannot delete own document after grant'; end if;
  raise notice 'PASS: with explicit grant, A can SELECT/INSERT/UPDATE/DELETE OWN records';

  -- ISOLATION: A cannot see B's rows.
  perform 1 from public.reviews where id = '00000000-0000-0000-0000-0000000000b1';
  if found then raise exception 'FAIL: A can see B''s review (RLS broken by the grant)'; end if;
  select count(*) into n from public.reviews;
  if n <> 1 then raise exception 'FAIL: A sees % reviews, expected only own 1', n; end if;
  raise notice 'PASS: owner-only RLS still isolates A from B after the grant';
end $$;
reset role;

-- B sees only own records, not A's.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}', false);
set role authenticated;
do $$
declare n int;
begin
  select count(*) into n from public.reviews;
  if n <> 1 then raise exception 'FAIL: B sees % reviews, expected only own 1', n; end if;
  perform 1 from public.reviews where id = '00000000-0000-0000-0000-0000000000a1';
  if found then raise exception 'FAIL: B can see A''s review'; end if;
  raise notice 'PASS: user B sees only own records, never A''s';
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- anon must have NO access (we granted it nothing).
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '', false);
set role anon;
do $$
begin
  perform 1 from public.reviews;
  raise exception 'FAIL: anon can read application tables (should have no grant)';
exception
  when insufficient_privilege then
    raise notice 'PASS: anon has no access to the application tables (42501)';
end $$;
reset role;

do $$ begin raise notice '============  DATA API GRANTS TEST: ALL CHECKS PASSED  ============'; end $$;

rollback;
