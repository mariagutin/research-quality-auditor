# ADR-0005: Review uploads — direct-to-Storage upload, server-verified save

## Date and status
2026-11-10. Accepted.

> Builds on [ADR-0003](0003-use-supabase.md) (Supabase for Auth, PostgreSQL, and
> Storage; owner-only RLS as the enforcing boundary) and
> [ADR-0004](0004-auth-supabase-ssr-sessions.md) (cookie-based SSR sessions). This
> ADR records how the first MVP feature — uploading a report and transcripts and
> saving a review — is built (checklist item 9).

## Context
A researcher uploads one report (`.md`) and one or more transcript (`.md`) files
and saves a "review". The files hold research data and must stay private to the
owner; the review and its document rows must never be recorded unless the files
really exist and are usable. Two systems are involved that cannot share one
transaction: Supabase **Storage** (the file bytes) and **PostgreSQL** (the
`reviews` / `documents` rows). We needed a save that is either fully done or not
done at all, and that recovers sensibly from interruptions.

## Decision

### 1. The browser uploads files directly to a private Storage bucket
The browser (acting as the signed-in user) uploads each file straight to the
private `review-files` bucket under `{userId}/{reviewId}/{filename}`, rather than
sending the bytes through a Next.js server action.

Why:
- **No server-action body limit.** Next.js server actions cap the request body at
  1 MB by default; transcripts can exceed that. Direct upload avoids the cap (and
  the extra browser→server→Storage hop).
- **It's the standard Supabase upload path**, and it streams straight to Storage.
- **No loss of safety.** The upload carries only the user's own session
  (publishable key); owner-only Storage policies (see below) mean the browser can
  only ever write inside the user's own folder. No service-role key is used.

The bucket is **private** with owner-only RLS on `storage.objects`: a user may
`SELECT`/`INSERT`/`DELETE` only objects whose first path folder equals their
`auth.uid()`. There is deliberately **no `UPDATE` policy** — the workflow only
uploads, reads, and deletes; it never moves, renames, or overwrites a file — so
every update is denied and the stored object name is fixed once uploaded.

### 2. The server finishes the save (verify, then record atomically)
After uploading, the browser calls a server action that *finishes* the save. The
server does not trust the browser's word that the files arrived or are valid. As
the signed-in user it:

1. **Re-validates the request shape** (exactly one report + ≥1 transcript, `.md`
   filenames, no duplicates, each transcript has a confirmed participant id).
2. **Verifies the files** under the user's own `{userId}/{reviewId}` folder:
   each expected file is present in the Storage listing, downloads, is non-empty,
   **decodes as UTF-8 text**, has **non-whitespace** content, and — for a
   transcript — actually contains the confirmed participant's **speaker label**
   (e.g. `P03:`). A file can exist and be larger than zero bytes yet be unreadable,
   so presence and size are not enough; the bytes are read.
3. **Creates the review + documents atomically** by calling the database function
   `create_review_with_documents(...)` (one transaction; all rows or none). The
   review's display name is the report filename minus `.md`; the status starts at
   the pre-check `draft`.

The review row is created **last**, so a visible review always has its files and
document rows behind it. The derived `storage_path`s and the user id come from the
server's own authenticated identity, never from the request.

### 3. Retries reuse the same review id when the inputs are unchanged
The `reviewId` is generated once in the browser and **reused while the files and
participant ids are unchanged**. This makes finishing **idempotent**:

- Before recording, the server checks whether a review with this id already
  exists and, if so, only treats it as saved when its stored documents **match**
  this save (same files and participant ids); a mismatch is a conflict, not a
  success. A duplicate-id error from the database is reconciled the same way.
- **Interrupted upload** (a file didn't finish uploading) → the UI offers **Try
  again**, re-uploading only the missing file under the **same** id.
- **Unconfirmed save** (timeout / transient failure where the outcome is unknown)
  → the uploaded files are **kept** and **Try again** re-runs the finish step; if
  the first attempt had actually committed, the id lookup finds it and just opens
  it.
- **Any change to the files or participant ids** (replacing a rejected file,
  adding/removing a file, editing an id) **clears the id**, so the next save is a
  fresh review id. A file that uploaded but failed a content check is rejected and
  must be replaced or its id corrected — which is a new save.

## Consequences
- **A partially-saved review can never appear.** The invariant is "a review row
  exists only if its files and document rows exist."
- **Orphaned files are possible but harmless.** If a researcher abandons a save
  after uploading (or a cleanup is skipped), files can remain under a `reviewId`
  that has no review row — invisible as a review. A later housekeeping sweep, or
  the eventual delete feature, reclaims them. We keep files on uncertain outcomes
  rather than delete them, so a save that actually committed is never torn down.
- **Deletes must go through the Storage API.** Supabase's `storage.protect_delete`
  trigger blocks direct SQL deletes on `storage.objects`; review deletion will use
  `storage.from('review-files').remove([...])` (which still applies the owner-only
  DELETE policy), not SQL.
- **Two migrations must be applied to hosted before this works there**:
  `20261109000000_create_review_with_documents_function.sql` and
  `20261110000000_create_review_files_storage_bucket.sql`. Both pass against the
  local stack and are **not yet applied to hosted**.
- **Verified locally.** The database function and Storage policies have synthetic
  SQL tests (`supabase/tests/`), and the finish-save logic was exercised against
  the local stack (happy path, idempotent retry, conflict, missing/unreadable/
  whitespace/missing-label files). Browser testing (`docs/running-locally.md`)
  confirmed recovery after all files uploaded but the final save could not be
  confirmed; an interruption during the file transfer itself is not yet tested in
  the browser.
- **Still out of scope here:** running the quotation check, listing/renaming
  reviews, persisting the data-handling acknowledgment, and review deletion.
