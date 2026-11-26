# ADR-0011: Upload and processing budgets per review (SEC-02)

## Date and status
Decided 2026-11-24. **Accepted and implemented** on branch `sec02-upload-budgets`
(not yet merged). Resolves the "upload limits" decision left open in ADR-0002.

## Context
ADR-0002 recorded that per-upload limits were "not yet decided," and the Week 6
security requirement **SEC-02** ("Enforce upload and processing budgets") requires
documented, enforced limits on file size, transcript count, and total bytes per
review, checked at the trusted boundaries before expensive work, with clear
messages and recoverable state on rejection.

Serverless execution limits (ADR-0002) make an unbounded number or size of files a
real processing risk, and Storage without a ceiling would accept arbitrarily large
objects.

## Decision
A single review may contain:

- **one report and up to 12 transcripts** (13 files total);
- **each `.md` file up to 115 KB**; and
- **1,495 KB total per review** (= 13 × 115 KB).

"KB" means **KiB (1024 bytes)**, the unit a file manager shows: 115 KB = 117,760
bytes; 1,495 KB = 1,530,880 bytes.

These limits are defined once in `lib/reviews/budgets.ts` and enforced at every
layer:

1. **Storage ceiling (hard gate).** Migration `20261124000000` sets the
   `review-files` bucket `file_size_limit` to 117,760 bytes, so Storage refuses an
   oversized PUT before any application code runs.
2. **Save boundary** (`lib/reviews/finish-save.ts`): the transcript count is
   checked in `validateShape`; per-file size and the per-review total are checked
   in `verifyFiles` from the Storage listing (before downloading) with a real
   byte-length backstop during the content read. Over-count/over-size return a
   clear `invalid`/`file_rejected` result; the review stays recoverable and no
   document rows are written.
3. **Check boundary** (`lib/reviews/run-check.ts`): the same count and size budget
   is re-verified before the download + analysis (defense in depth).
4. **Client form** (`app/reviews/new/upload-form.tsx`): per-file size is flagged
   inline and the "+ Add transcript" control is capped at 12, for a friendly
   message. This is UX only; the server is the authority.

## Consequences
- Ordinary valid uploads (one report + up to 12 transcripts, each ≤ 115 KB) succeed
  unchanged.
- Oversized or too-many-file inputs are rejected with a specific message, and the
  existing retry/cleanup paths (ADR-0005, ADR-0008) recover the review state
  without partial results.
- Changing a limit is a one-line edit in `budgets.ts` plus, for the Storage
  ceiling, a one-line `UPDATE` migration.
- The per-review total and transcript count cannot be expressed on the bucket, so
  they remain application-enforced; the bucket enforces only the per-object size.

## Revision history
- 2026-11-24: Initial decision and implementation (SEC-02).
