# Manual browser checklist (local only)

A short, by-hand pass over the five flows, against the **local** stack with
synthetic data. No new tooling — just the browser, the already-running dev server,
and `docker exec … psql` for the two state-injection steps.

> Local, disposable Supabase only. Never run against hosted. These steps create
> and delete synthetic data under your own local account.

## Setup (no installs)

1. **Local stack up:** `npx supabase status` should list the API at
   `http://127.0.0.1:54321`. If not, `npx supabase start`.
2. **Dev server up:** it is already running (`npm run dev`) on
   **http://localhost:3000** with the local env. If not, `npm run dev`.
3. **Sign in:** open http://localhost:3000, go to **/login**, and sign up / sign in
   with a throwaway email (e.g. `me@synthetic.test`). Local confirmation emails, if
   any, appear in the local mail viewer at **http://localhost:54324**.
4. **Synthetic files:** create two tiny `.md` files on your machine:
   - `report.md`
     ```
     # Report

     The study notes, "a statement that is not present in any transcript at all."
     ```
   - `p03.md`
     ```
     Moderator: Welcome.
     P03: I thought the onboarding was clear.
     ```
   (The report's quote is absent from the transcript, so the check yields exactly
   one issue — enough to exercise decisions.)

## 1. Upload (review-row-first, progress, duplicate-submit)

- Home → **Start a new check** (`/reviews/new`). Tick the data-handling box.
- Choose **report.md** as the report; **+ Add transcript** → **p03.md**; set its
  Participant ID to `P03`. Click **Save check**.
- Expect: while saving, the **Save button and inputs are disabled** and a progress
  bar shows "Uploading…/Finishing…"; a double-click does nothing; on success you
  land on the review page as **Saved · pre-check**.

## 2. Quotation checking

- On the review, click **Run check**. Expect **"Check complete."** and a Results
  section: `Checked 1 quotation · 1 issue found`, with the quote shown and a
  **Quote not found** chip. (An "uncertain" save would appear as a **warning**, not
  an error — not reproducible by hand; see the automated test.)

## 3. Decisions (reselect no-op, switch, no clearing, count after save)

- Under the issue, pick **Dismiss**. Expect "Review decision saved: Dismiss" and the
  progress line reads **All 1 issue reviewed**.
- Click **Dismiss again** → nothing changes (no clear, still Dismiss).
- Click **Investigate** → it switches; the reviewed **count stays the same** (1).
- There is **no "clear"/"unreviewed" control**.

## 4. Deletion (confirm, return to list, cleanup-pending message)

- Scroll to **Delete this check** → a confirmation dialog appears → **Delete**.
- Expect to return to **Your checks**, with the review gone and its files removed.
- (If file cleanup can't finish, the message says the check was deleted and its
  files are *still being removed* — it does **not** claim all files are gone.
  **Retained cleanup records are the recovery mechanism**; the next visit to
  **/reviews** finishes the sweep.)

## 5. Recovery controls (database-time active vs recoverable)

These need a review in a busy state. Make a second review (repeat step 1), open it,
and copy its id from the URL `/reviews/<REVIEW_ID>`. Then inject a state — either
with psql (container `supabase_db_research-quality-auditor`), or by pasting the same
`update …` SQL into the local **Studio SQL editor** at http://localhost:54323
(no terminal needed):

- **Active check → Delete disabled:**
  ```
  docker exec -i supabase_db_research-quality-auditor psql -U postgres -d postgres -c \
   "update public.reviews set processing_status='processing', op_token=gen_random_uuid(), op_heartbeat_at=now(), op_failed_at=null where id='<REVIEW_ID>';"
  ```
  Reload the page → "A check is running…"; **Delete is disabled** ("once the check
  finishes").
- **Interrupted check → Delete enabled (recoverable):** rerun the command above with
  `op_heartbeat_at=now() - interval '3 minutes'`. The page auto-refreshes (busy
  state) within ~20s, or reload → **Delete becomes enabled** ("This check was
  interrupted. Deleting will clean it up.") and the **Run check** button is offered
  again.
- **Deletion interrupted → Retry enabled:** set `processing_status='deleting'` with
  the stale `op_heartbeat_at`. Expect **"Deletion interrupted"** with **Retry
  delete** enabled. (A *fresh* `deleting` — `op_heartbeat_at=now()` — shows
  **"Deletion in progress"** with Retry **disabled**.)

> **Two-minute timing tip.** The staleness window is **2 minutes of no heartbeat**.
> During a slow manual walkthrough it elapses on its own, so a review you just set
> "active" can read "interrupted" by the time you look (the busy page also
> auto-refreshes and re-checks database time). To see the **active (Delete
> disabled)** state, set a fresh heartbeat (`op_heartbeat_at = now()`) and **reload
> within ~2 minutes**; leaving it will flip active → interrupted on its own.

Delete the review afterward (UI) to clean up, or leave it (local synthetic data).

## 6. Review status on Your checks

Open **/reviews** (*Your checks*). Each check shows one status chip; completed
checks show the researcher's review progress, never a count:

| The check | Expected chip |
|---|---|
| Saved, not checked yet | **Not checked yet** (unchanged) |
| Uploading / running / failed / being deleted | its existing status, e.g. `processing` (unchanged) |
| Completed, at least one issue without a saved decision (including none decided) | **Review in progress** |
| Completed, every issue has a saved decision | **Review complete** |
| Completed, quotations checked and no issues | **No issues found** |
| Completed, zero quotations detected | **No quotations found** (never "No issues found") |
| Completed, but the counts couldn't be loaded | **Review status unavailable** |

- Use the step 1–3 files to see **Review in progress** (before deciding the one
  issue) and **Review complete** (after deciding it). The **No issues found** and
  **No quotations found** states use the 2026-11-15 files below
  (`report-exact-matches.md`, `report-no-quotes.md`).
- The chip colors are unchanged: completed checks stay blue.
- **Review status unavailable** can't be produced by hand without breaking the local
  stack; it is covered by `scripts/ci/list-status.test.mts`, as is reading every row
  when there are more than the API's per-request row limit (1,000).

**Verified on 2026-11-20 (local) — manual observation by Maria.** On *Your checks*
in her local browser, against the local stack and synthetic local data, the page
displayed **Review complete**, **Review in progress**, **No issues found**, and
**Not checked yet**. These match the statuses expected from the local data at the
time (worked out from the local database before the check).

Not observed in this pass: **No quotations found** (no zero-quotation check in the
local data), **Review status unavailable** (not reproducible by hand), and the
unfinished statuses other than *Not checked yet*. These are covered only by
`scripts/ci/list-status.test.mts`.

## Verified on 2026-11-13 (local)

A full pass was run by hand against the local stack. Observed **passes**:

- **Upload:** landed on the review page ("Saved · pre-check") with both files listed.
- **Quotation checking:** "Checked 1 quotation · **1 issue found**" with the **Quote
  not found** chip (using the `rqa-sample` files).
- **Decisions:** save; **reselecting the chosen decision is a no-op**; switching
  changes it; the reviewed count is unchanged on a switch; **no clear control**.
- **Deletion:** confirmation dialog → returned to *Your checks* with the review gone
  (its issue, quotation, and files cascaded away — confirmed in the database).
- **Recovery controls (database time):** **active check → Delete disabled**;
  **interrupted/stale check → Delete enabled** ("This check was interrupted…"),
  surfaced on its own by the busy-page auto-refresh; **interrupted deletion →
  "Deletion interrupted" + Retry delete enabled**.

**Not interactively verified** in this pass:

- The upload **duplicate-submit guard / progress bar** (local uploads are
  near-instant; the upload itself succeeded).
- The **"uncertain" check result** warning (not reproducible by hand).
- The **fresh-deletion "Deletion in progress" + Retry-disabled** contrast (described;
  the active-check *disabled* state covered the same active-gating principle).
- **Accessibility is not comprehensively verified.** Existing a11y features are
  intact, but a dedicated accessibility audit (screen-reader / keyboard-only) is
  **deferred until after MVP**; no WCAG/compliance is claimed (see
  `development-checklist.md` → "Scope decision — accessibility").

## Verified on 2026-11-15 (local) — results-state empty states

A follow-up by-hand pass against the local stack, focused on the two "nothing to
flag" states and the bug that previously conflated them. All synthetic files under
`~/Desktop/rqa-sample/`. Observed **passes**:

- **No issues (every quotation matched):** uploaded `report-exact-matches.md` with
  `p03.md` + `p05.md`. The report holds exactly two quotations, each a verbatim match
  to its participant's transcript — *"the dashboard saved me time."* (P03) and
  *"I abandoned the export after the second screen."* (P05). Result: **"Checked 2
  quotations · 0 issues found"** and the green **"No issues found. Every quotation
  matched a participant's transcript."** alert, with no issue entries. (The P05 match
  spans a line break and tolerates the transcript's trailing comma vs. the report's
  period — punctuation is normalized.)
- **No quotations found (corrected — TR-18):** uploaded `report-no-quotes.md` (prose
  only, no double-quoted text) with a transcript. Result: the **"Checked N
  quotations"** summary line is **suppressed** (0 quotations), and the review shows
  the info alert **"No quotations found to check. No text in double quotation marks
  was found in the report."**
  - **Bug fixed:** previously a report with zero quotations wrongly rendered the
    TR-17 success message *"No issues found. Every quotation matched…"* — implying a
    successful match had occurred when nothing was checked. The review page now
    branches on `resultState()` (three states: `no_quotations` / `no_issues` /
    `has_issues`), so zero-quotation reviews get the distinct info message instead of
    the success one. Guarded by the `scripts/ci/result-state.test.mts` unit test.

> Display-only fix: the saved review data is unchanged (the zero-quotation review
> still stores 0 quotation rows); only the rendered empty-state message differs.

## Explicitly not covered here

- **In-flight upload race** (a Storage PUT already accepted and still transferring
  when a retry/deletion takes over) is **unverified** — the client API gives no way
  to hold a request mid-transfer. The design handles late files via the
  convention sweep + rowless-folder invariant, exercised by the automated delete
  tests, but the genuine in-flight race itself is not confirmed.
- **Cleanup-record retirement** is **deferred**; records are retained and keep
  driving owner-return cleanup.

## Known limitations found in testing

Findings from manual runs that are intentionally left unfixed are recorded in
[`docs/testing/known-limitations.md`](testing/known-limitations.md) — e.g. **QE-1**
(HW #4, 2026-11-15): a double-quoted product name in the report (`"Nimbus"`) is
extracted as a participant quotation and flagged "Quote not found", inflating the
counts; Dismiss works and extraction rules are deliberately left unchanged.
