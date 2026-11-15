# ADR-0008: Concurrency-safe review lifecycle, leases, and file cleanup

## Date and status
2026-11-12. Accepted (design settled; database migrations `20261112000000` and
`20261112010000` applied and tested on the **local** stack only).

> Supersedes the "application-enforced" note in the initial schema
> (`20261105000000`) and extends the Storage bucket policies
> (`20261110000000`). Implements the safe-concurrency requirements for uploading,
> checking, and deleting a review (TR-15, NFR-01), across multiple browser tabs.
> **App wiring is pending** (see "Status of work"); until then the app is
> temporarily incompatible with these policies on purpose.

## Context
A researcher can upload a review's files, run its quotation check, and delete it —
possibly from more than one tab, and possibly after a tab was closed mid-operation.
Three things must hold: (1) conflicting operations on the **same** review cannot
run together or overwrite each other's status; (2) a check is marked `complete`
only after its results are actually saved — a timeout is never proof it stopped;
(3) deleting database rows must never orphan files in Storage, and no stray or
late-arriving file may be silently left behind. Operations on **different** reviews
must remain independent.

The app runs only as the signed-in user (publishable key); the service-role key is
never used, so Row Level Security and these policies are the real boundary.

## Decision

### 1. Review-row-first and the per-attempt lease
A review row exists **before any file is sent** (status `uploading`), so every
legitimate file has an owning review row. Each busy operation holds a lease on the
review, stored in three columns added to `reviews`:

- `op_token uuid` — identifies the current attempt **and** fences its writes; for
  uploads it is also the Storage path segment (section 4).
- `op_heartbeat_at timestamptz` — last recorded activity, written with the
  **database** clock (`now()`), never a client clock.
- `op_failed_at timestamptz` — set when an attempt is **confirmed** failed, so
  recovery need not wait for the staleness timeout.

An operation is **active** while `op_failed_at IS NULL AND op_heartbeat_at > now()
- 2 minutes`. It becomes **recoverable** once `op_failed_at` is set **or** it goes
stale (two minutes with no heartbeat). A timeout only makes a review eligible for
takeover; it never marks a review `complete`.

Operations are started by database functions that stamp a fresh token:
`begin_upload`, `retry_upload`, `begin_review_op('processing'|'deleting')`. Activity
is refreshed by `touch_review_op`, and confirmed failure recorded by
`fail_review_op` (uploading/deleting → `op_failed_at`; processing → `failed`).

### 2. Fencing — an interrupted or superseded operation cannot write
`finish_upload`, `record_quotation_results`, and `finalize_review_deletion` each
lock the review row and require `op_token = <caller's token> AND op_failed_at IS
NULL AND <expected status>`, else they raise and write nothing. So if an operation
stalls and is taken over (a retry, a reclaim, or a delete re-stamps the token), the
original's late write hits a changed token and changes nothing. `complete` is set
**only** inside `record_quotation_results`, in the same transaction as the saved
results. `touch_review_op` is fenced the same way, so an **obsolete or
confirmed-failed** attempt cannot heartbeat itself back to active.

### 3. Allowed transitions (enforced in `begin_review_op`)
| From | → `processing` (check) | → `deleting` (delete) |
|---|---|---|
| draft / failed | yes | yes |
| complete | **no re-run** | yes |
| uploading (active) | no (finish first) | **blocked** (files preserved) |
| processing (active) | no (running) | **blocked** (files preserved) |
| uploading / processing (recoverable) | processing only from stale processing | yes (reclaim) |
| deleting (active) | no | **no competing deletion** |
| deleting (recoverable) | no | yes (recover, new token) |

### 4. Storage uploads are tied to the current attempt
Files are stored at `{user_id}/{review_id}/{op_token}/{filename}`. The
`review-files` INSERT policy (migration `20261112010000`) allows a PUT only when it
is the caller's own folder **and** a review exists for that id, owned by the caller,
`uploading`, not confirmed-failed, with `op_token` equal to the path's token
segment. This rejects: uploads once the review is no longer `uploading`
(additional-upload and post-deletion cases), uploads under a retired/stale token,
uploads for a deleted review (ids are never reused), and cross-user uploads.
`SELECT`/`DELETE` policies are left **owner-folder only**, so an owner can still
list and remove files after the review row is gone — which every cleanup path
needs. (A subtle bug caught in testing: the review lookup must qualify the object
path as `objects.name`, because `reviews` also has a `name` column.)

### 5. Upload-retry cleanup — fixed-target reminders
When `retry_upload` retires the old token `T_old` and stamps `T_new`, it atomically
inserts one durable reminder row into `review_dead_upload_attempts(review_id,
token=T_old)`. `retry_upload` is the **sole** inserter, so the live `op_token` is
never a dead token, and no reminder can name a future attempt. Cleanup deletes only
`{uid}/{reviewId}/{token}/` for a **token named in a reminder** — never "every
folder except the current one" — so a stale worker that resumes after a newer
attempt started still cannot touch the newer attempt's files. The finish gate uses
"the retired folders are **currently empty**" (checked by the app over the Storage
API) as a precondition; it does **not** require reminders to be removed, so a
retained reminder never blocks the upload from completing.

### 6. Review-deletion cleanup — a durable whole-prefix record
`finalize_review_deletion` is the only path that deletes a review row. In one
transaction it inserts a durable `review_file_cleanups(user_id, review_id, prefix,
finalized_at)` record **and** deletes the row (cascade). A `BEFORE DELETE` guard on
`reviews` refuses any delete without that successor record, so dropping rows can
never orphan files, and the per-attempt reminders may cascade away because the
whole-prefix record has taken over responsibility for all of them. The review row
is deleted **before** the authoritative sweep so the prefix becomes **rowless** —
by the review-row-first invariant every file there is then garbage, and no new PUT
can be authorized (ids are never reused). A straggler that lands after retirement is
still caught by the rowless-folder invariant (a folder with no owning review row is
removable), which is safe from races because a deleted review spawns no concurrent
attempts.

### 7. Decision guard
A `BEFORE INSERT/UPDATE/DELETE` trigger on `review_decisions` locks the parent
review and refuses a decision write while the review is `uploading`/`processing`/
`deleting`, **except** the review's own deletion cascade, which is permitted via a
transaction-local setting scoped to that exact review id (set only inside
`finalize_review_deletion`). The DELETE arm is **defense only** — the UI never
clears a decision (ADR-0007 stands: pick one of three, reselect is a no-op, no
clearing).

### 8. Heartbeats
Long legitimate operations refresh `op_heartbeat_at` on a timer (covering a single
long file transfer or analysis phase, not only the gaps between files/phases), via
the fenced `touch_review_op`. "Two minutes" therefore means two minutes with **no
recorded activity**, judged on database time.

## Honest limitations
- **Cleanup is eventual and owner-driven.** There is no background worker; a cleanup
  or reconciler pass runs **only when the owner returns** (opens the reviews list,
  or an explicit resume). It is **not guaranteed to run if they never return**. A
  straggler file can briefly exist until the next pass; what is guaranteed is
  *whether* it is removed, not *how soon*.
- **No documented bound on an accepted upload's server-side lifetime.** The Supabase
  docs do not publish a standard-upload request timeout or a TUS session expiry, so
  a cleanup record is **not retired on an assumed duration**, and repeated
  empty-folder observations are not treated as proof. Retirement of cleanup records
  / reminders while a review still lives is **deferred**; for now they persist and
  are reused on each pass, and deletion cascades clear the per-attempt reminders.
- **The policy does not cancel an already-accepted in-flight PUT.** Correctness
  relies on the sweep + rowless-folder invariant, not on the policy aborting a
  request already in flight.
- **Cascade-exception trust.** The scoped transaction-local flag is safe because no
  RPC exposes arbitrary `set_config`/SQL to clients and the service-role key is
  never in the app.
- **Temporary app incompatibility.** The current app uploads to
  `{uid}/{reviewId}/{filename}` and creates the review row last, so under the new
  INSERT policy those PUTs are rejected and `run-check.ts` still calls the old
  2-arg `record_quotation_results`. This is expected; uploads and checks work again
  only after the app-wiring phase. `create_review_with_documents` is kept until
  `finish_upload` is wired in.

## Status of work
- **Done (local only):** migration `20261112000000` (lifecycle, lease columns, the
  two cleanup tables, the functions, the decision guard, the delete guard) and
  migration `20261112010000` (the upload-attempt Storage policy). Database behavior
  is covered by `supabase/tests/review_lifecycle_test.sql` and the updated
  `review_files_storage_test.sql`, with the prior suite still green.
- **App wiring — UPLOAD flow (done, local):** `begin_upload`-first (review-row
  first), token-path uploads, `finish_upload`, timer heartbeats
  (`touch_review_op`), confirmed-failure handling (`fail_review_op`), full retry on
  the same review id with a fresh token (`retry_upload`) gated on fixed-target
  cleanup (uploads are held if cleanup is pending; the attempt id/token are
  preserved and cleanup resumes without creating another attempt), and a
  reconcile-first resume so an uncertain outcome whose `finish_upload` actually
  succeeded opens the existing Draft rather than re-uploading, failing it, or
  starting another review. Covered by the real-Storage tests
  `scripts/upload-flow.local-test.mts`, `scripts/upload-retry.local-test.mts`
  (incl. the T2-cleanup-paused-while-T3-starts case), and
  `scripts/upload-recovery.local-test.mts` (cleanup-aware retry + uncertain-save
  reconcile). **UI controls** (duplicate-submit prevention via a disabled button +
  an in-flight re-entrancy guard; progress controls that disable inputs and keep
  the tab on the page until success/failure) are **code-reviewed and typecheck
  clean; interactive browser verification is still pending** (no browser-test
  tooling installed yet).
- **App wiring — CHECK flow (done, local):** `runReviewCheck` acquires the
  processing lease via `begin_review_op('processing')` (so a completed review
  cannot be re-run, and an active check or a review being deleted blocks a new
  check), carries that token into `record_quotation_results` (fenced, so an
  outdated attempt cannot save results or flip the status), heartbeats with
  `touch_review_op` during the check, and on a confirmed failure releases the lease
  to `failed` via the token-fenced `fail_review_op`. Unexpected exceptions from
  downloads/analysis are routed through that same fenced failure path, and the
  heartbeat timer is cleared on every path. The heartbeat **awaits** `rpc()` (the
  Supabase client is lazy — a non-awaited `void supabase.rpc(...)` never sends the
  request). A results-save whose outcome is unknown is reported as `uncertain` and
  reconciled by state (reconciles to `complete` if it actually committed; releases
  the lease only when still ours), kept distinct from a confirmed failure. Covered
  by `scripts/run-check.local-test.mts` (analysis + integration + lease/fence: no
  re-run, active-blocks-competing, outdated-attempt-cannot-write) and
  `scripts/check-heartbeat.local-test.mts` (empirical lazy-vs-awaited rpc, the timer
  advancing `op_heartbeat_at` during a delayed check, the exception path, and the
  uncertain-vs-confirmed distinction). The check UI (`run-check-button`) now renders
  the `uncertain` result as a **warning** ("couldn't confirm the save"), distinct
  from a confirmed `error`, and refreshes so the page reflects the true state.
- **App wiring — DELETE flow (done, local):** `deleteReview` acquires the delete
  lease via `begin_review_op('deleting')` (refused while an upload/check is active —
  blocked, files preserved — and while a deletion is already active — no competing;
  reclaims a recoverable one), then `finalize_review_deletion` creates the durable
  whole-prefix `review_file_cleanups` record and deletes the row (cascade:
  documents/quotations/issues/decisions and the per-attempt reminders) in one
  token-fenced transaction, and finally sweeps the files under the review's **exact**
  prefix. The record is **retained** (not retired on empty). Owner-driven recovery
  (`resumePendingDeletions`, run best-effort on the reviews-list load) finishes an
  interrupted deletion whose sweep didn't complete; a stale `deleting` is reclaimed
  by a fresh delete. Covered by `scripts/delete-review.local-test.mts`
  (full-delete+cascade+handoff+real-removal+retained-record; active-operation
  blocking with files preserved; both recovery paths; exact-prefix isolation). The
  **deletion UI** (`delete-review-button`, on the review page): a "Delete this
  check" button with a confirmation dialog; **disabled only while the operation is
  ACTIVE** and enabled for a recoverable (confirmed-failed or stale) one, so an
  interrupted upload/check never leaves Delete permanently disabled; a "Deletion in
  progress" state whose **Retry delete** is enabled only once the deletion has
  failed or stalled ("Deletion interrupted") and disabled while an active deletion
  is in progress; other review actions (check, decisions) are hidden while
  `deleting`. The active-vs-recoverable distinction is computed with **database
  time** by a read-only helper `review_op_active` (migration `20261112020000`:
  busy AND `op_failed_at IS NULL` AND `op_heartbeat_at > now() - 2 min`), surfaced
  by the server component; the check button is likewise offered for a recoverable
  failed/stale check but hidden while one is actively running. `deleteReview` now
  reports `cleanupPending`, and when the records are deleted but the file sweep did
  not finish the UI shows an **accurate** message ("the check was deleted; its files
  are still being removed and will finish on your next visit") rather than claiming
  all files were removed.
- **App wiring — DECISION flow (done, local):** the **database guard**
  (`reject_decision_during_op`, covering INSERT/UPDATE/DELETE) is the authoritative
  protection; `setDecision` no longer pre-checks the status — it upserts and maps
  the guard's refusal (P0001) to a friendly message naming the busy state, and the
  owner FK's rejection to "that issue no longer exists". The agreed UI behavior is
  unchanged: three exclusive options, clicking the selected one is a no-op, choosing
  another switches it, **no clearing control**, and the displayed decision + reviewed
  count update only after the save succeeds (read back from the database). Covered by
  `scripts/decisions.local-test.mts` (save/switch/persistence; reviewed count
  unchanged when switching; writes blocked while `processing`/`deleting` with the
  stored decision unchanged; allowed again once `complete`).
- **Done (local):** all four app flows are wired — **upload, check, delete, and
  decision**.
- **Real multi-op overlap (done, local):** `scripts/overlap.local-test.mts` drives
  genuinely overlapping operations (a check is paused mid-flight, holding the
  `processing` lease, while the conflict is attempted) and the real upload/delete
  paths: an active check blocks delete and refuses a competing check (files
  untouched, original completes); `uploading` refuses a check and accepts one after
  finish; an active upload blocks delete while a stale one is reclaimed and deleted;
  `deleting` refuses a check and a decision write (stored decision unchanged); and an
  active check on review A does not block checking B or deleting C (independence).
- **Open-page recovery refresh (done, local):** the review page recomputes
  `review_op_active` (database time) on each render, and a small `BusyRefresh` client
  component re-runs the server component on an interval **while the review is busy**,
  so an already-open page surfaces the recovery controls (Delete / Retry enable)
  once the operation goes stale or confirmed-failed — without a manual reload. The
  `review_op_active` flip is covered by `review_lifecycle_test.sql` section 9; the
  actual in-browser refresh is **browser-verification pending**.
- **Deferred (remaining checklist):** **interactive browser verification** of the
  UI controls (upload duplicate-submit/progress; decision no-op-on-reselect /
  switch / no-clear; the deletion button, confirmation dialog, disabled-while-busy,
  "Deletion in progress" / "Deletion interrupted" + Retry, the cleanup-pending
  message, and the busy-refresh surfacing recovery controls); an already-accepted
  **in-flight PUT finalizing after takeover** (needs a way to hold a Storage request
  mid-transfer — not reproducible through the client API in these tests); and
  **deciding when a cleanup record / reminder may be safely retired**.

## Consequences
Concurrency safety is enforced in the database (status + token + guards), so it
holds across tabs and does not depend on client timing. The cost is more moving
parts (three lease columns, two bookkeeping tables, eight functions, three guards)
and a cleanup story that is *eventually* consistent and owner-activity-driven. The
design is intentionally conservative: where a guarantee could not be established
(accepted-upload lifetime), the system keeps durable records rather than retire on
assumptions.
