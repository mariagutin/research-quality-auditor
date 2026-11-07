# Database tests

Tests for the Research Quality Auditor schema (migration
`20261105000000_init_research_quality_auditor_schema.sql`).

> **Local, disposable Supabase only — never hosted.** These tests create and
> delete synthetic data. Run them against your local `supabase start` stack.

## `rls_two_user_test.sql` — synthetic two-user RLS + constraint test

Exercises, with two synthetic users, the guarantees described in
`docs/database-design.md`:

1. **Owner happy path** — an owner can create a full review graph under RLS.
2. **Isolation** — each user sees only their own rows, never the other's.
3. **RLS rejections** — a user cannot spoof ownership or link into another
   user's review (`insufficient_privilege` / `42501`).
4. **Structural rejections** — the composite foreign keys reject owner-mismatch,
   wrong document-role, and cross-review links **even when RLS is bypassed**
   (service-role / superuser, `foreign_key_violation` / `23503`).
5. **Evidence-free issue** — a `quote_not_found` issue with no transcript is
   accepted (`source_document_id IS NULL`).
6. **Cascade delete** — deleting a review removes its children, while the other
   user's data and the owner's other review survive.

### What it does to the database

- Inserts two fake users (`user-a@synthetic.test`, `user-b@synthetic.test`) and
  fake reviews/documents/quotations/issues/decisions.
- **Everything runs in one transaction that ends in `ROLLBACK`.** On success or
  failure, nothing is committed — the database is left exactly as it was. The
  script is safe to re-run any number of times and needs no cleanup step.
- It never writes to Storage and never touches real data.

### Prerequisites

- Docker running, and the local stack up: `npx supabase start`
  (check with `npx supabase status`).
- The migration applied to the local database (`npx supabase db reset` applies
  all migrations to the local stack; it **drops and recreates the local
  database**, so only run it on local/disposable data).

### Run it

The script talks only to the local Postgres container, so run it through
`docker exec` (no `psql` needed on your machine). From the repo root:

```sh
docker exec -i supabase_db_research-quality-auditor \
  psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -f - < supabase/tests/rls_two_user_test.sql
```

## `grants_data_api_test.sql` — Data API grants test

Verifies migration `20261106000000_grant_data_api_access_to_authenticated.sql`:
that a signed-in (`authenticated`) user can reach their own rows **without**
relying on Supabase's automatic table grants, while owner-only RLS still isolates
users and `anon` gets no access.

Because a local `supabase start` stack auto-grants table privileges, this test
reproduces the hosted "**Automatically expose new tables** = disabled" condition
by revoking those auto-grants inside its transaction, then applying the exact
grants from the migration and checking:

- **Negative control** — with grants revoked, even the owner is blocked (`42501`),
  proving the grant is genuinely required (RLS alone is not enough).
- **Owner access** — after the grant, the owner can SELECT/INSERT/UPDATE/DELETE
  their own rows.
- **Isolation** — owner-only RLS still hides the other user's rows.
- **anon** — has no access to the application tables.

Same safety model as above: synthetic data only, one transaction that ends in
`ROLLBACK`, local only, no cleanup needed. Run it the same way:

```sh
docker exec -i supabase_db_research-quality-auditor \
  psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -f - < supabase/tests/grants_data_api_test.sql
```

> Prerequisite: the grants migration must be applied to your local DB first
> (`npx supabase migration up`, or `npx supabase db reset` to replay all
> migrations — both local only).

- The container name follows `supabase_db_<project-dir-name>`. Confirm yours
  with `docker ps --format '{{.Names}}' | grep supabase_db`.
- `-v ON_ERROR_STOP=1` makes psql stop and return a non-zero exit code on the
  first failed check.

## `revoke_anon_privileges_test.sql` — anon least-privilege test

Verifies migration `20261106120000_revoke_anon_table_privileges.sql`: after it
runs, the `anon` role has **no privileges** on any of the five application
tables, while `authenticated` keeps its SELECT/INSERT/UPDATE/DELETE access.

This matters because `anon` is otherwise left with platform-default privileges
the app never uses — including `TRUNCATE`, which is **destructive**: it empties a
table outright and, unlike `DELETE`, is not filtered by RLS. The test is
self-contained — it performs the same revoke the migration does, inside a
transaction that ends in `ROLLBACK`, and only reads the privilege catalog
(`information_schema`), so it touches no data. Run it the same way:

```sh
docker exec -i supabase_db_research-quality-auditor \
  psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -f - < supabase/tests/revoke_anon_privileges_test.sql
```

### Reading the result

- A clean run prints a series of `PASS:` / `SETUP:` notices, ends with
  `================  ALL CHECKS PASSED  ================`, then `ROLLBACK`, and
  **exits 0**.
- A failed check prints `ERROR: FAIL <n>: ...`, stops immediately, and **exits 3**.
  The transaction still rolls back, so a failed run also leaves no data behind.

### Cleanup

None required — the transaction rolls back, so no synthetic data is ever
committed. If you ever edit the script to `commit` instead of `rollback`, remove
the synthetic users (their data cascades away via the `on delete cascade` from
`reviews.user_id`) with:

```sh
docker exec -i supabase_db_research-quality-auditor \
  psql -U postgres -d postgres \
  -c "delete from auth.users where email like '%@synthetic.test';"
```
