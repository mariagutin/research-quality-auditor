# ADR-0007: Per-issue review decisions

## Date and status
2026-11-11. Accepted.

> Builds on the one-entry-per-issue results view (ADR-0006) and uses the
> `review_decisions` table created in the initial schema
> (`20261105000000_init_research_quality_auditor_schema.sql`). Implements the
> review-decision step of `docs/architecture.md` (TR-10 – TR-12, UR-06/07,
> NFR-05).

## Context
After a check, the researcher assigns one decision to each flagged issue —
**Needs correction**, **Dismiss**, or **Investigate** — and can edit it later.
The `review_decisions` table already enforces the shape: `decision` is a text
column CHECK-constrained to those three values, `issue_id` is **UNIQUE** (zero or
one decision per issue), the row is tied to the issue's owner by a composite
foreign key, and owner-only RLS applies. So this is a server action plus UI — **no
migration**.

## Decision

### 1. Saving a decision (`lib/reviews/decisions.ts` + server action)
`setDecision(supabase, userId, issueId, decision)` runs AS the signed-in user and
**upserts** on `issue_id` — set or change, always exactly one row. A decision is
only ever one of the three values; there is no clear operation.

`app/reviews/actions.ts` exposes it as `setDecisionAction`. RLS and the issue's
owner foreign key are the enforcing boundary; the value is validated against the
allowed set before the write.

### 2. Persist, then confirm (NFR-05)
The control calls the action and only then refreshes; the selection and the
progress count are read back **from the database**. So the updated selection and
the confirmation appear only after storage succeeds — the confirmation names the
saved choice, "Review decision saved: Needs correction / Dismiss / Investigate".
On failure it says so and nothing changes.

### 3. Interaction: pick one of three; reselect is a no-op
Before the first decision, no option is selected. The three options are
exclusive; clicking the already-selected option **does nothing**. Switching to a
different option saves the new choice and updates the confirmation after the save
succeeds; because any saved decision already counts as reviewed, switching leaves
the reviewed count unchanged. A decision, once made, is always one of the three —
there is **no clearing**, by the screen or otherwise.

### 4. Progress and completion
Review progress = issues with a saved decision ÷ total issues ("2 of 3 issues
reviewed"); when every issue has a decision it reads "All N issues reviewed. Your
decisions are saved." Any saved decision counts as reviewed; **changing** a
decision does not change the count. Decisions are stored and counted separately
and **never change the checking totals** ("Checked 1 quotation · 2 issues
found") (TR-12).

### 5. "Run again" is removed from the review screen
Re-running a check calls `record_quotation_results`, which clears and re-inserts
the quotations and issues; the decisions on those issues then cascade-delete.
Rather than guard against that, **the check runs once** — the "Run again" button
is gone entirely. The check button is shown only in the pre-check state; after a
review is complete there is no way to re-run it from the screen, so reviewing and
switching decisions never regenerate issues or lose work. Re-running a completed
review is deliberately not supported yet; we revisit it when there is a clear
reason (e.g. editing files and re-checking while keeping decisions). No decision
controls beyond the three options are shown.

## Consequences / limitations
- **A completed review cannot be re-checked from the screen** (by design, for
  now) — hence removing the button rather than warning. A future change could
  re-key decisions to something more stable than the regenerated issue id if
  re-checking while keeping decisions is needed.
- **One decision per issue**, enforced by the UNIQUE constraint; the upsert keeps
  it to a single row through any number of changes.
- The reviewed count and completion message are derived on each render from the
  stored decisions, so they always match the database.

## Verification
- `scripts/decisions.local-test.mts` — the saved-confirmation text, plus (against
  the local stack) running a check to produce a real issue, then save → switch →
  switch back, asserting ownership and the single-row invariant throughout.
- `scripts/issues-view.local-test.mts` — the view attaches each issue's decision
  and computes the reviewed count.
- `tsc` clean; the review route compiles; hosted Supabase untouched (no schema
  change, no migration).
