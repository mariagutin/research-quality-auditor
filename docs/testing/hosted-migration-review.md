# Hosted migration review — Week 4 deploy

> Prepared 2026-11-15. **Read-only review; nothing was applied, pushed, or deployed.**
> All remote queries ran through the Supabase CLI in a read-only transaction
> (`db query --remote --read-only`) or the management API (`migration list`,
> `projects list`). Applying migrations to hosted still requires Maria's explicit
> authorization.

## Target project

| | |
|---|---|
| Name | **Research Quality Auditor** |
| Project ref | `czrjqgxmtpdxfkohwlkh` |
| Organization | `tguevzmdptfnlgoewwqd` |
| Region / engine | us-east-1 · Postgres 17.11 · `ACTIVE_HEALTHY` |
| Linked locally | yes (`supabase/.temp/project-ref`), `config.toml` project_id = `research-quality-auditor` |

## Pending migrations (7)

`supabase migration list --remote` shows the remote has only the **first four**
migrations applied (`20261105000000` → `20261107100034`). Everything from
`20261109000000` onward is pending:

| # | Migration | Changes | "Delete"-type ops (all definitional — no user data removed at apply time) |
|---|---|---|---|
| 1 | `20261109000000_create_review_with_documents` | Adds `create_review_with_documents()` fn; EXECUTE→authenticated | none |
| 2 | `20261110000000_create_review_files_storage_bucket` | Creates **private** `review-files` bucket + owner-only SELECT/INSERT/DELETE policies | none (`insert … on conflict do nothing`) |
| 3 | `20261110120000_add_quotation_match_evidence` | Adds `quotations.matched_document_id`, `matched_role` (NOT NULL default `'transcript'`), `matched_excerpt` + FK + **2 CHECK constraints** + index; `record_quotation_results(uuid,jsonb)` fn | none |
| 4 | `20261111000000_record_issue_source_evidence` | `CREATE OR REPLACE record_quotation_results(uuid,jsonb)` to also record issue `source_document_id`/`source_excerpt` | none |
| 5 | `20261112000000_review_lifecycle_and_operation_leases` | Adds `reviews.op_token/op_heartbeat_at/op_failed_at`; **widens** `processing_status` CHECK; 2 new tables (`review_dead_upload_attempts`, `review_file_cleanups`) + owner-only RLS; 9 lifecycle fns; 2 triggers | `drop constraint` (re-added, widened — superset, safe); `drop function record_quotation_results(uuid,jsonb)` → replaced by **3-arg** version |
| 6 | `20261112010000_tie_review_uploads_to_current_attempt` | **Replaces** the Storage INSERT policy with a stricter one requiring the `{uid}/{reviewId}/{op_token}/` path on an `uploading` review | `drop policy review_files_owner_insert` (recreated tighter) |
| 7 | `20261112020000_review_op_active` | Adds read-only UI helper `review_op_active()` | none |

**No table drops, no column drops, no row deletions, no `TRUNCATE`.** The
`delete from quotations/reviews` statements are inside function bodies (runtime
behavior when a check runs or a review is deleted), not executed during migration.

Dependency check: migration 11's function references `issues.source_document_id` /
`source_excerpt` / `source_role`; these are defined in the **init** migration
`20261105000000` (already applied on the remote), so the function resolves at runtime.

## Read-only constraint check — findings

The only apply-time data risk is migration 3's new CHECK constraints on `quotations`:
- `quotations_no_issues_requires_match` — a `checking_result = 'no_issues'` row must
  have a non-NULL `matched_document_id`. Since the column is added NULL in the same
  migration, **any existing `no_issues` row would fail the ALTER.**
- `quotations_match_evidence_paired` — `matched_document_id` and `matched_excerpt`
  present/absent together (satisfied by existing rows, which get NULL/NULL).

Read-only count on the remote (`db query --remote --read-only`, 2026-11-15):

| Table | Rows |
|---|---|
| `quotations` total | **0** |
| `quotations` with `checking_result = 'no_issues'` | **0** |
| `reviews` | **0** |
| `issues` | **0** |
| `documents` | **0** |

**Result: no rows can violate the new constraints.** The hosted database holds no
application data, so all three new CHECKs (and the widened `reviews` status CHECK)
apply against an empty table. Safe to apply.

## Is an older app currently live? — No

| Signal | Finding |
|---|---|
| Local Vercel link (`.vercel/`) | none |
| `vercel` CLI | not installed |
| Deployment URLs in repo | none |
| GitHub deployments (`repos/.../deployments`) | **0** |
| GitHub environments | none |
| Hosted data + RPCs | DB empty; save/check RPCs + Storage bucket (migrations 09–12) not applied |

Nothing has ever been deployed for this repo, and no functioning frontend could run
against the current hosted schema. **This is a clean first deployment**, so the
app↔DB sequencing risk (tightened migrations breaking a live old app) does not apply.

## Exact migration command + deployment order

The repo app already uses the **new** contract (`begin_upload` → upload under the
`{uid}/{reviewId}/{op_token}/` path → `finish_upload`; 3-arg `record_quotation_results`),
verified by the local `upload-flow` and `storage-isolation` tests. So the clean order is
migrations first, then deploy the (already-compatible) app.

**0. (optional) Preview exactly what would be applied — no changes:**
```sh
npx supabase db push --remote --dry-run
```
> Ran 2026-11-15. Output confirmed exactly the 7 migrations above would be pushed, in
> timestamp order, with **no seeds and no roles** (`upToDate: false`, `dryRun: true`);
> hosted unchanged. Note: a dry-run lists the set/order but does **not execute the SQL**,
> so it does not by itself guarantee each migration's DDL succeeds on hosted — the real
> apply is the test. `db push` applies each migration in its own transaction, so a
> mid-batch failure leaves earlier migrations applied and is resumable by re-pushing.

**1. Apply the 7 pending migrations (requires Maria's authorization).** `db push`
applies pending migrations in timestamp order, each in its own transaction:
```sh
npx supabase db push --remote
```
- In this agent session the CLI blocks hosted mutations and asks for confirmation;
  it proceeds only with explicit authorization (add `--yes` only when Maria has
  authorized this specific run). It may prompt for the database password — Maria
  enters it (e.g. run it herself via `! npx supabase db push --remote`).
- The **secret / service_role key is never used or entered** for any of this.

**2. Verify the apply (read-only):**
```sh
npx supabase migration list --remote        # all 7 now show a remote timestamp
npx supabase db query --remote --read-only "select to_regclass('public.review_file_cleanups') as t1, to_regclass('storage.objects') is not null as storage_ok;"
```

**3. Deploy the app to Vercel (first deploy):**
- Create/link the Vercel project; set env vars **`NEXT_PUBLIC_SUPABASE_URL`** and
  **`NEXT_PUBLIC_SUPABASE_ANON_KEY`** (publishable/anon key only). **Never** set the
  service_role / secret key in Vercel or any `NEXT_PUBLIC_` var.
- In Supabase Auth: set **Site URL** + redirect URLs to the Vercel domain; configure
  **custom SMTP** for confirmation emails (Week 4 item).

**4. Live verification on hosted:** sign up / log in; create a review (upload report +
transcript); run a check; confirm owner-only isolation with a second account.

## Status

- Read-only review complete; **hosted unchanged**. No commit, push, or deployment made.
- Blocking item before step 1: Maria's explicit authorization to apply to hosted.
