# Architecture — Research Quality Auditor (MVP #1)

> Status: draft for review. This document describes the intended architecture for
> MVP #1 as defined by the confirmed scope, User Requirements (UR), Technical
> Requirements (TR), Non-functional Requirements (NFR), and the Week 2 Technical
> Build Plan. Items marked **Open decision** are not yet settled and must be
> resolved before the dependent feature is implemented.

## Purpose and boundaries

Research Quality Auditor helps a researcher compare quotations in a research
report against the original interview transcripts, inspect discrepancies, and
record a review decision for each issue. The research report and transcripts are
Markdown (`.md`) files.

What a result means, and does not mean:

- A **match** confirms the quotation is consistent with the supplied transcript.
  It does **not** establish that the transcript is correct, that the report's
  conclusions are supported, or that the report is complete.
- **"Quote not found"** does **not** mean "fabricated." A missing source file, a
  transcription difference, or a shortened quotation can all explain a mismatch.

Out of scope for MVP #1 includes unsupported-conclusion detection, completeness
review, participant-frequency checks, audio/video processing, real-time
assistance, research synthesis, third-party integrations, multi-user
collaboration, advanced dashboards, enterprise administration, report editing or
automatic correction, issue-specific AI chat, and any file format other than
`.md`.

---

## The three tiers

```
┌──────────────────────────────────────────────────────────────────────┐
│  Tier 1 — Interface (browser)                                          │
│  Next.js (App Router) + TypeScript + Material UI                       │
│  Screens: sign in/up, data-handling acknowledgment, upload & preview,  │
│  participant-ID confirmation, run check, results summary, issue +      │
│  evidence view, review decisions, saved reviews, delete.               │
└───────────────┬────────────────────────────────────────────────────────┘
                │ HTTPS (authenticated requests)
                ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Tier 2 — Server logic (Vercel)                                        │
│  Next.js server-side code (route handlers / server actions)           │
│  - Access checks (owner-only)                                          │
│  - Upload validation (.md only, non-empty, readable)                   │
│  - Speaker-label validation against confirmed participant ID          │
│  - Quotation extraction + candidate-passage lookup (AI-assisted)      │
│  - Evidence verification: returned excerpts checked against source    │
│  - Issue creation, results, and decision persistence                  │
│  Holds all privileged credentials and AI API keys (never in browser). │
└──────┬───────────────────────────────────────┬────────────────────────┘
       │ Supabase client (signed-in user session;│ HTTPS
       │ owner-only RLS + storage policies)       │
       ▼                                          ▼
┌──────────────────────────────┐      ┌──────────────────────────────────┐
│  Tier 3 — Supabase           │      │  AI provider (Open decision)      │
│  - Auth (accounts)           │      │  Assists extraction + finds       │
│  - PostgreSQL + RLS (records)│      │  candidate passages. Server       │
│  - Storage (private .md)     │      │  verifies everything it returns.  │
└──────────────────────────────┘      └──────────────────────────────────┘
```

### Tier 1 — Interface: Next.js + Material UI (the screens)

The browser tier renders every screen with Material UI components and holds no
secrets. Its responsibilities:

- Present sign-up / sign-in / sign-out (UR-10, TR-15).
- Show the data-handling notice with a link to details, and an **initially
  unchecked** acknowledgment checkbox that must be selected before uploads are
  enabled (UR-16, TR-19, NFR-03).
- Upload report and transcript files, show filenames, counts, and content
  previews, and allow replace/remove before checking (UR-11, TR-01, TR-03).
- Confirm or enter the participant ID for each transcript (UR-13, TR-05).
- Trigger a check, show processing status and a loading indicator, and prevent
  duplicate submissions (NFR-09, TR-13).
- Show the results summary, the list of selectable issues, the evidence view for
  a selected issue, and the per-issue decision control (UR-02–UR-09, TR-09–TR-12).
- Show review progress and the completion message (TR-11, TR-20).
- List saved reviews, reopen them, and delete one after confirmation
  (UR-14, UR-15, TR-16).

Accessibility is a first-class requirement at this tier: keyboard-only operation
with visible focus indicators (NFR-06), status conveyed by text/indicators and
not color alone (NFR-07), and meaningful labels plus screen-reader announcements
for processing, save, and error events (NFR-08).

Source excerpts and transcript passages are displayed as **verbatim, escaped
text** — not rendered Markdown/HTML — so the displayed evidence matches the
uploaded text exactly (NFR-04) and no embedded code or in-file instructions are
executed or obeyed (NFR-11). AI-generated explanations are visually separated
from source quotations (NFR-04).

### Tier 2 — Server logic on Vercel

All trusted work runs server-side in Next.js on Vercel. The browser never talks
to the database or the AI provider directly. Responsibilities:

- **Access control.** Ordinary researcher requests run against Supabase using the
  **signed-in user's own session** (their Supabase Auth token), not a privileged
  server key. Access is therefore enforced by owner-only policies in the database
  itself — row-level security (RLS) on every records table and owner-only storage
  policies on the private bucket — so documents, participant IDs, results,
  decisions, and stored files are reachable only by their owner (TR-15, NFR-01).
  The server adds its own ownership checks, but the database policies remain the
  enforcing boundary even if a server check is missed. Should a specific
  operation genuinely require elevated (service-role) access that bypasses these
  policies, that is treated as a **separate decision to be documented and
  justified** — including why it is needed, its exact scope, and how it stays off
  the ordinary request path — not a default connection mode.
- **Upload validation.** Accept only `.md`; reject other formats with an
  explanation that MVP #1 accepts only `.md` (TR-01, TR-02). Verify each file is
  readable, non-empty text; require replacement or removal of invalid files
  (TR-04).
- **Speaker-label validation.** Require speaker turns labeled `Moderator:` and
  the confirmed participant ID (for example `P03:`). Only participant-labeled
  speech is used to verify quotations. If required labels are missing or conflict
  with the confirmed ID, identify the problem and ask the researcher to correct
  and re-upload (TR-05, TR-06).
- **Quotation extraction.** Identify direct participant quotations in the report,
  preserve their wording, and capture their listed participant IDs; flag a
  missing ID as "Participant not specified"; exclude paraphrases and summaries
  (TR-07).
- **Comparison.** Compare each quotation against participant-labeled speech
  across all uploaded transcripts, checking wording and participant identity
  (TR-08).
- **Evidence verification.** The AI provider assists with extraction and with
  finding candidate passages, but **server code verifies that every returned
  excerpt actually appears in the original source text** before it is stored or
  shown. Nothing is invented; a quote with no corresponding passage yields a
  no-match result (TR-08, TR-09, NFR-04).
- **Persistence and errors.** Create issue records, save results and decisions,
  report processing status, and on failure allow retry without re-uploading;
  never present a failed or incomplete check as "No issues found"
  (TR-13, TR-14, NFR-05).

Credentials and AI API keys live only on the server and are kept out of browser
code, the public repository, and user-facing errors (NFR-01). Full reports,
transcripts, quotations, and passwords are kept out of logs; logs carry only
what is needed to diagnose a problem, such as a review ID and an error type
(NFR-02).

> **Open decision — processing shape.** Whether a check completes within a single
> server request or needs background processing depends on the chosen upload
> limits and provider latency. This must be settled before the comparison feature
> is built, because it affects the Vercel execution model and how progress is
> reported (NFR-09).

### Tier 3 — Supabase: accounts, records, and private files

- **Auth.** Supabase Auth manages accounts and sessions; the user's session token
  authorizes their ordinary requests (UR-10, TR-15).
- **PostgreSQL.** Structured records for reviews, documents, quotations, issues,
  and decisions (see data model below). Every table carries **row-level security
  (RLS)** policies that restrict rows to their owner, enforced against the
  signed-in user's session (TR-15).
- **Storage.** Uploaded `.md` files are held in a **private** bucket governed by
  **owner-only storage policies**; they are never public and are reachable only by
  their owner through that user's session (TR-15, NFR-01).

Deletion removes the selected review's files, results, and decisions from active
app storage, and confirms deletion only after that removal succeeds; if deletion
fails or is incomplete, the status is explained and retry is allowed. Deletion
from provider systems or backups is promised only if verified mechanisms support
it (TR-16, NFR-12).

---

## Data model (from the Build Plan)

| Table | Holds |
|-------|-------|
| `reviews` | owner, review name, processing status, timestamps |
| `documents` | review, role (report/transcript), filename, private storage location, confirmed participant ID (transcripts), validation status |
| `quotations` | review, report document, original wording, listed participant ID (if present), report location, checking result |
| `issues` | review, quotation, issue type, explanation, source transcript reference + exact excerpt (when available) |
| `review_decisions` | issue, owner, current decision, timestamps — exactly one current decision per issue |

Issue types: **wording mismatch**, **participant mismatch**, **participant not
specified**, **quote not found**. A single quotation can produce more than one
issue (for example, both a wording mismatch and an attribution mismatch), and
each issue is a separate, individually reviewable item (TR-07, TR-08, TR-10).

Counts are derived, not editing the originals:

- **Review progress** = issues with a saved decision ÷ total issues. Any saved
  decision counts as reviewed; changing a decision does not increase the count
  (TR-11, NFR-05).
- **Results summary** = total quotations checked, quotations with no issues
  found, and individual issues flagged; multiple issues on one quote are counted
  separately; review decisions never change the checking totals (TR-12).

> **To confirm — acknowledgment persistence.** TR-19 / UR-16 / NFR-03 require the
> data-handling acknowledgment before upload. The Build Plan defines the
> acknowledgment *flow* but not where it is *recorded*. Recommendation: persist
> the acknowledgment (owner, timestamp, and the provider-policy version
> acknowledged) so it is auditable and enforceable per upload. This is noted for
> the data-model step, not yet implemented.

---

## End-to-end walkthrough (one example)

This traces a single review from upload to a saved decision. It assumes the
researcher has an account and is signed in.

1. **Acknowledge data handling.** On the upload screen the researcher reads the
   data-handling notice (with a link to details) and selects the initially
   unchecked acknowledgment checkbox. Only then are uploads enabled. During early
   testing the notice states that only synthetic or appropriately anonymized
   materials may be uploaded. *(TR-19, NFR-03)*

2. **Upload materials.** The researcher uploads one report, `report.md`, and two
   transcripts, `interview-p03.md` and `interview-p05.md`. The server accepts
   only `.md`, and checks each file is readable and non-empty; the interface
   shows filenames, the file count, and a content preview. *(TR-01, TR-02, TR-04,
   UR-11)*

3. **Confirm participant IDs.** For each transcript the interface suggests a
   participant ID from the file's contents where possible; the researcher
   confirms `P03` for the first and `P05` for the second (or enters one if none
   can be suggested). *(TR-05, UR-13)*

4. **Validate speaker labels.** The server checks that each transcript uses
   `Moderator:` and the confirmed ID as speaker labels (for example `P03:`). If a
   file's labels are missing or conflict with the confirmed ID, the researcher is
   asked to correct and re-upload before the check can run. *(TR-06)*

5. **Confirm and run.** The researcher confirms the files are correct and
   complete, and starts the check. The interface shows a loading indicator and
   status, and prevents a second click from starting a duplicate check. Valid
   files remain stored, so a failed check can be retried without re-uploading.
   *(TR-03, TR-13, NFR-09)*

6. **Extract quotations.** The server (AI-assisted) identifies direct participant
   quotations in `report.md`, preserving wording and capturing each listed
   participant ID. Suppose it extracts:

   > "We abandoned the onboarding flow after the second screen." — attributed to
   > **P03**

   *(TR-07)*

7. **Compare against transcripts.** The server compares that quotation against
   participant-labeled speech across both transcripts, checking wording and
   participant identity. The AI proposes a candidate passage; **the server
   verifies the returned excerpt appears verbatim in the source** before using
   it. Suppose the matching passage is found in `interview-p05.md`, spoken by
   **P05**, not P03. The server creates a **participant mismatch** issue (a
   separate issue would be created for a wording difference, and so on). *(TR-08,
   NFR-04)*

8. **Show the evidence.** The researcher selects the issue and sees: the report
   quote, the relevant transcript passage shown as verbatim escaped text, both
   participant IDs (reported `P03` vs. source `P05`), the source filename
   (`interview-p05.md`), and an explanation that is visually separated from the
   source text. Had no passage been found, the view would instead show "No
   matching passage found in the uploaded transcripts" without inventing
   evidence. *(TR-08, TR-09, UR-04, UR-05, NFR-04, NFR-11)*

9. **Record a decision.** The researcher assigns one decision to the issue —
   **Needs correction**, **Dismiss**, or **Investigate** — here, *Needs
   correction*. The decision is shown as saved only after storage succeeds; if
   saving fails it is marked unsaved and kept available for retry, and the
   reviewed count is unchanged. The decision remains editable. *(UR-06, UR-07,
   TR-10, NFR-05)*

10. **Progress and summary.** The results summary shows quotations checked,
    quotations with no issues found, and individual issues flagged. Review
    progress shows how many issues have a saved decision out of the total. When
    every issue has a saved decision, the interface shows
    "All *N* issues reviewed. Your decisions are saved." — issues and decisions
    stay visible and editable, and are not described as resolved or corrected.
    *(TR-11, TR-12, TR-20)*

11. **Return later, or delete.** The researcher can reopen this saved review with
    its results and decisions intact, without rerunning the check. They can also
    delete this specific review after confirmation, which removes its files,
    results, and decisions from active app storage while preserving other
    reviews. *(UR-14, UR-15, TR-14, TR-16, NFR-12)*

### Alternate result states

- **No issues found.** If the check completes, at least one quotation was
  checked, and no issues were detected: show "No quotation issues found" and the
  number checked, omit the issue list and decision controls, and clarify the
  check covers quotation wording and participant identity only. *(TR-17)*
- **No quotations found.** If no direct participant quotations are identified:
  show "No quotations found to check" and let the researcher review or replace
  the report; this is not presented as a successful quotation check. *(TR-18)*
- **Processing failure.** Explain the failure and allow retry without
  re-uploading; never show a failed or incomplete check as "No issues found."
  *(TR-13)*

---

## Open decisions

These are not settled and block the features that depend on them.

1. **AI provider and model.** Including data-handling (retention, training-use,
   deletion) policies, accuracy, and cost. The provider must be named in the
   data-handling notice and its policy reviewed and documented before
   confidential materials are processed. *(NFR-03; blocks extraction and
   comparison.)*
2. **Per-quote classification cutoff (matching rules).** How a single quotation
   is classified against a candidate passage: the handling of punctuation,
   spacing, shortened quotes, and ellipses, and the cutoff that separates a
   *possible wording difference* from *quote not found* for that one quote. This
   is a per-quote decision rule applied at check time, and it directly shapes the
   "not found ≠ fabricated" behavior. *(TR-08.)*
3. **Quality acceptance targets (measured across test cases).** Distinct from the
   per-quote cutoff in (2): the aggregate quality thresholds the system must meet
   across a labeled test set — missed issues, incorrect flags, participant-
   matching accuracy, and source-excerpt accuracy — documented together with test
   results and known limitations before any reliability claim is made. Tuning the
   cutoff in (2) is what moves these aggregate numbers, but these targets are
   measured over many cases, not applied to a single quote. *(NFR-10.)*
4. **Upload limits.** Maximum upload size, transcript count, and total text.
   These interact with the processing-shape decision in (5) and with Vercel
   execution limits. *(Blocks the upload and comparison features.)*
5. **Processing shape.** Whether a check completes within a single server request
   or needs background processing — driven by the upload limits in (4) and
   provider latency, and affecting the Vercel execution model and how progress is
   reported. *(NFR-09; also noted inline in Tier 2.)*
6. **Acknowledgment persistence.** Where the data-handling acknowledgment is
   recorded — recommended: owner, timestamp, and the acknowledged provider-policy
   version — so it is auditable and enforceable per upload. *(TR-19, UR-16,
   NFR-03; also noted inline in the data model.)*

Also to settle alongside the above: performance and cost targets (NFR-09,
NFR-10), and retention and backup policy (NFR-12).
