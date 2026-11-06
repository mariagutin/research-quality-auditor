# Database design — Research Quality Auditor (MVP #1)

> Status: **design + initial migration written; applied and tested locally.** This plans
> the database and is implemented by the migration
> `supabase/migrations/20261105000000_init_research_quality_auditor_schema.sql`, which has
> been applied to a **local, disposable** Supabase stack and passed a synthetic
> two-user test suite (owner access, isolation, cross-review/role links, evidence-free
> issues, cascade deletion) on 2026-11-06. **It has NOT been applied to hosted Supabase**,
> and no real research data has been used. It is based on the confirmed scope,
> User/Technical/Non-functional Requirements, and `docs/architecture.md`.
>
> **Assumptions** and **Open questions** are labeled inline.

## Accounts and files: two things we do *not* model as ordinary tables

- **Accounts are handled by Supabase Auth.** Users live in Supabase's built-in
  `auth.users`. We do **not** create our own users table and we do **not** store
  passwords anywhere — Supabase Auth manages credentials (UR-10, TR-15, NFR-01).
  Our tables refer to a person by their Supabase Auth user id (`user_id →
  auth.users.id`).
- **Uploaded files live in Supabase Storage, not in the database.** The actual
  `.md` bytes are stored as objects in a **private Storage bucket**. The database
  only stores **records that describe** each file (its filename, its role, its
  location/path in the bucket, its validation status). So "the file" and "the row
  about the file" are two different things kept in two different places:
  - *File (bytes):* private Storage bucket, referenced by a storage path.
  - *Record (metadata):* the `documents` table row, which holds that path plus the
    descriptive fields. This separation matters for deletion (see "Deleting a
    review and its data" below) and keeps large text out of the database.

---

# What does the app need to save?

- The **account** each person signs in with — provided and managed by Supabase
  Auth, not a table we build.
- A **review**: one quotation-checking job a researcher runs, with a name, its
  processing status, and when it was created and last updated.
- The **documents** in a review: one research report and one or more interview
  transcripts, each described by filename, role, its location in private Storage,
  the confirmed participant ID (for transcripts), and whether it passed validation.
- The uploaded **file contents** themselves — the `.md` bytes — stored in private
  Supabase Storage, not in the database.
- The **quotations** extracted from the report: the original wording, the listed
  participant ID if the report gave one, where it appears in the report, and the
  overall checking result for that quotation.
- The **issues** found for a quotation: the type of issue, an explanation, and,
  when evidence exists, which transcript it came from and the exact verbatim
  excerpt.
- The **review decision** a researcher records for each issue: one of Needs
  correction, Dismiss, or Investigate — zero or one current decision per issue (none
  until the issue is reviewed).
- **(Open question)** A record that the researcher **acknowledged the data-handling
  notice** before uploading — see Open product decisions; not modeled as a decided
  table yet.

---

# Tables

> Convention for every table below: `id` is a UUID primary key; `user_id` is the
> owning Supabase Auth user (`auth.users.id`); `created_at` / `updated_at` are
> timestamps. **Assumption:** UUID keys (Supabase default) rather than serial
> integers. Status/result/type fields are stored as **`text` columns with a `CHECK`
> constraint** that limits each column to its fixed set of allowed values (see
> "Allowed values" below). **Decided:** `text` + `CHECK` rather than a Postgres
> `enum` type. The exact *set* of allowed values is now finalized in the initial
> migration (not yet applied); value sets can still evolve later via an ordinary
> constraint change.

## Allowed values (enforced with `text` + `CHECK`)

**Decided:** the status, result, issue-type, and decision columns are plain `text`
columns, each guarded by a `CHECK` constraint that restricts it to a fixed set of
allowed values. We are **not** using Postgres `enum` types.

*Why `text` + `CHECK` rather than `enum`:* adding, renaming, or retiring an allowed
value is an ordinary constraint change, which is simpler to evolve during an MVP than
altering a shared `enum` type (Postgres `ALTER TYPE ... ADD VALUE` has its own
restrictions, and removing an enum value is awkward); the stored values stay directly
readable in queries and exports; and the database still rejects any value outside the
set. The columns and their constraints:

| Table | Column | Allowed values (CHECK) | Note |
| --- | --- | --- | --- |
| reviews | processing_status | `draft`, `processing`, `complete`, `failed`, `deleting` | Finalized in the initial migration; a failed/incomplete check must never read as "no issues" (TR-13). |
| documents | validation_status | `pending`, `valid`, `invalid` | Finalized in the initial migration (TR-02, TR-04). |
| quotations | checking_result | `no_issues`, `has_issues` | Finalized in the initial migration; drives TR-12 summary counts. |
| issues | issue_type | `wording_mismatch`, `participant_mismatch`, `participant_not_specified`, `quote_not_found` | Set fixed by TR-07/TR-08. |
| documents | role | `report`, `transcript` | Set fixed by the data model. |
| review_decisions | decision | `needs_correction`, `dismiss`, `investigate` | Set fixed by TR-10 (the three required decision labels). |

The `CHECK` SQL now lives in the initial migration (not yet applied). Value sets can
still change later via an ordinary constraint change; the enforcement mechanism
(`text` + `CHECK`) is decided.

## Table name: reviews

**What it stores:** One quotation-checking job owned by one researcher.

| Column name | Type | Required? | What it means |
| --- | --- | --- | --- |
| id | uuid | Yes | Unique id for the review. |
| user_id | uuid | Yes | The person who owns this review (`auth.users.id`). |
| name | text | Yes | A name the researcher gives the review. |
| processing_status | text | Yes | Where the check is: `draft`, `processing`, `complete`, `failed`, `deleting`. `text` + `CHECK` (see Allowed values), finalized in the migration. Must never let a failed/incomplete check read as "no issues found" (TR-13). |
| created_at | timestamptz | Yes | When the review was created. |
| updated_at | timestamptz | Yes | When the review last changed. |

**Who can see it?** Only the owner (`user_id = auth.uid()`).
**Who can add, change, or delete it?** Only the owner.

## Table name: documents

**What it stores:** One uploaded file's **description** (report or transcript). The
file's bytes live in private Storage; this row points to them.

| Column name | Type | Required? | What it means |
| --- | --- | --- | --- |
| id | uuid | Yes | Unique id for the document record. |
| review_id | uuid | Yes | The review this document belongs to (→ `reviews.id`). |
| user_id | uuid | Yes | Owner, copied here so access rules are simple and defensive. Must equal the owner of `review_id`. |
| role | text | Yes | `report` or `transcript`. `text` + `CHECK` (see Allowed values). **Assumption:** exactly one `report` per review; one or more `transcript`. |
| filename | text | Yes | The original filename shown to the researcher. |
| storage_path | text | Yes | Where the file's bytes live in the private Storage bucket. This is a pointer, not the file. |
| participant_id | text | No | Confirmed participant ID for a transcript (e.g. `P03`); empty for a report (TR-05, TR-06). |
| validation_status | text | Yes | `pending`, `valid`, `invalid` — readable/non-empty `.md` check (TR-02, TR-04). `text` + `CHECK` (see Allowed values), finalized in the migration. |
| created_at | timestamptz | Yes | When the record was created. |

**Who can see it?** Only the owner.
**Who can add, change, or delete it?** Only the owner, **and only for a review they
own** (see Access rules — this prevents attaching a document to someone else's
review).

## Table name: quotations

**What it stores:** One direct participant quotation extracted from the report, plus
its overall checking result.

| Column name | Type | Required? | What it means |
| --- | --- | --- | --- |
| id | uuid | Yes | Unique id for the quotation. |
| review_id | uuid | Yes | The review this quotation belongs to (→ `reviews.id`). |
| report_document_id | uuid | Yes | The **report** document it was extracted from (→ `documents.id`; must be a document in this same review with `role = 'report'`). |
| report_role | text | Yes | Fixed-value column, always `'report'` and `NOT NULL` (see Rules for linked records). Part of the composite foreign key that forces `report_document_id` to point at a `role = 'report'` document. `report_document_id` is itself required, so this key is always enforced. Not shown to users. |
| user_id | uuid | Yes | Owner; must equal the owner of `review_id`. |
| original_text | text | Yes | The quotation's wording, preserved exactly as written in the report (NFR-04). |
| listed_participant_id | text | No | The participant ID the report attributes it to, if any; empty means "Participant not specified" (TR-07). |
| start_offset | integer | Yes | Start position of the quotation in the report's original Markdown text (see Counting convention). |
| end_offset | integer | Yes | End position, **excluded** (half-open), so `end_offset - start_offset` is the quotation's length (see Counting convention). |
| checking_result | text | Yes | Outcome for this quotation: `no_issues`, `has_issues`. `text` + `CHECK` (see Allowed values), finalized in the migration; used for the TR-12 summary counts. |
| created_at | timestamptz | Yes | When the record was created. |

> **Counting convention for `start_offset` / `end_offset`.** Positions count
> **Unicode code points** (not bytes and not UTF-16 code units), **zero-based**, over
> the exact uploaded Markdown text. The interval is **half-open `[start_offset,
> end_offset)`** — the start is included, the end is excluded — so the length is
> `end_offset - start_offset`. **Bounds rule:** `0 ≤ start_offset < end_offset ≤`
> report text length (in code points). `start_offset` is strictly less than
> `end_offset`, so every quotation covers at least one code point (no empty ranges),
> and `end_offset` may equal the text length (the quotation can run to the end of the
> report). Code points (rather than UTF-16 units) match Postgres `substring`
> character semantics; the application must compute offsets the same way (e.g. iterate
> code points, not raw JS string indices) so a character outside the Basic Multilingual
> Plane (an emoji, some scripts) is counted as one position on both sides.
>
> **Why this handles repeated wording:** offsets name one exact location, so identical
> quotation text appearing twice in the report is stored as two rows with different
> offsets and never collapses (see also `original_text`, kept for display).
>
> **Verification (write-time invariant).** When a quotation row is written, the server
> must confirm that the report text sliced at `[start_offset, end_offset)` equals
> `original_text` exactly. If it does not, the row is not saved. **The uploaded source
> file is never modified after upload** (see Deleting a review — rows/paths are only
> ever added or removed, never rewritten), so these offsets stay valid for the life of
> the review.

**Who can see it?** Only the owner.
**Who can add, change, or delete it?** Only the owner, and only within a review they
own.

## Table name: issues

**What it stores:** One individual issue found for one quotation. A single quotation
can have several issues; each is its own row (TR-10, TR-12).

| Column name | Type | Required? | What it means |
| --- | --- | --- | --- |
| id | uuid | Yes | Unique id for the issue. |
| review_id | uuid | Yes | The review this issue belongs to (→ `reviews.id`). |
| quotation_id | uuid | Yes | The quotation this issue is about (→ `quotations.id`). |
| user_id | uuid | Yes | Owner; must equal the owner of `review_id`. |
| issue_type | text | Yes | One of `wording_mismatch`, `participant_mismatch`, `participant_not_specified`, `quote_not_found` (TR-07, TR-08). `text` + `CHECK` (see Allowed values). |
| explanation | text | No | AI-generated explanation of the issue, kept separate from source text (NFR-04). |
| source_document_id | uuid | No | The **transcript** the evidence came from (→ `documents.id`; must be a document in this same review with `role = 'transcript'`). Empty for `quote_not_found` and for quotations with no issues. |
| source_role | text | Yes | Fixed-value column, always `'transcript'` and `NOT NULL` (see Rules for linked records). Part of the composite foreign key that forces `source_document_id` to point at a `role = 'transcript'` document. Evidence-free issues such as `quote_not_found` are allowed by leaving **`source_document_id`** empty (NULL), which alone disables that foreign key (`MATCH SIMPLE`); `source_role` itself stays `'transcript'`. So whenever a document *is* linked, it always undergoes the same-review and transcript-role check. Not shown to users. |
| source_excerpt | text | No | The exact verbatim transcript excerpt, present only after the server verifies it appears in the source (TR-09, NFR-04). Empty for `quote_not_found`. |
| created_at | timestamptz | Yes | When the record was created. |

**Who can see it?** Only the owner.
**Who can add, change, or delete it?** Only the owner, and only within a review they
own.

> **Evidence lives on issues, and only for flagged issues.** The source comparison —
> `source_document_id` + `source_excerpt` — is stored on `issues`, never on
> `quotations`. A quotation that is an exact match has **no issue row**, so it stores
> **no evidence passage**: an exact match needs no evidence comparison and the UI
> shows none (TR-09, TR-17). Evidence is therefore present only for flagged issues
> that matched a passage (for example a wording or participant mismatch). A
> `quote_not_found` issue is flagged but has no matching passage, so its evidence
> fields stay empty and the UI shows the "no matching passage" message instead of a
> comparison (TR-08, TR-09).

## Table name: review_decisions

**What it stores:** The researcher's current decision for one **issue**. An issue has
**zero or one** decision: none until the researcher saves one (an unreviewed issue
has no row here), then one editable decision (TR-10, TR-11, NFR-05).

**Decision granularity — per issue, not per quotation (evidence).** The requirements
are explicit that decisions attach to individual issues, not to the quotation as a
whole: TR-10 — "Present each issue as a separate selectable item, even when several
issues concern the same quote. Save one editable decision per issue"; UR-06 —
"Record and change a decision for each issue"; TR-11 — progress counts "issues with
saved decisions out of the total"; TR-20 — completion is "every flagged issue has a
successfully saved decision." So a single quotation that produces both a wording
mismatch and a participant mismatch has **two** issues and can carry **two different
decisions**. This is treated as settled by the requirements, not an open product
question.

| Column name | Type | Required? | What it means |
| --- | --- | --- | --- |
| id | uuid | Yes | Unique id for the decision. |
| issue_id | uuid | Yes | The issue this decision is for (→ `issues.id`). **Unique** — at most one decision per issue; no row exists until the issue is reviewed. |
| user_id | uuid | Yes | Owner; must equal the owner of the issue's review. |
| decision | text | Yes | One of `needs_correction`, `dismiss`, `investigate`. `text` + `CHECK` (see Allowed values). |
| created_at | timestamptz | Yes | When the decision was first saved (counts the issue as "reviewed", TR-11). |
| updated_at | timestamptz | Yes | When the decision was last changed (changing it does not re-count, TR-11). |

**Who can see it?** Only the owner.
**Who can add, change, or delete it?** Only the owner, and only for an issue inside a
review they own.

---

# How the tables connect

- One **person** (Supabase Auth user) can have many **reviews**. Each review belongs
  to one person.
- One **review** has many **documents** (one report and one or more transcripts).
  Each document belongs to one review.
- One **review** has many **quotations**. Each quotation belongs to one review and
  was extracted from one **report document**.
- One **quotation** can have many **issues**. Each issue belongs to one quotation
  (and to the same review). A flagged issue may also point to one **source document**
  (the transcript the evidence came from).
- One **issue** has **zero or one** current **review decision**: none while it is
  unreviewed, and one once a decision is saved. Each decision belongs to one issue.

**Keeping records in the same review and owner.** Every child row carries a link to
its parent (`review_id`, `quotation_id`, or `issue_id`) *and* a `user_id`, and every
linked record must belong to the **same review and the same owner**. In particular:

- `documents.review_id`, `quotations.review_id`, and `issues.review_id` must each
  match their parents' review, all owned by the same person.
- `quotations.report_document_id` must reference a **report** document
  (`role = 'report'`) in that same review.
- `issues.source_document_id` must reference a **transcript** document
  (`role = 'transcript'`) in that same review.
- A `review_decisions` row belongs to an issue in that review, with the same owner.

The access rules below enforce same-owner and same-review on insert/update, so a row
can never be linked to another user's review or to the wrong kind of document (see
Access rules → Rules for linked records).

---

# Access rules

Supabase calls these Row Level Security (RLS). Supabase says to turn on RLS for
every table in an exposed schema. **None of this is applied yet** — it is the plan
for the migration.

**Plan (plain language; the SQL will come with the migration, not now):**

- **Turn RLS on for all five tables:** `reviews`, `documents`, `quotations`,
  `issues`, `review_decisions`.
- **`reviews`:** a person may read/insert/update/delete a row only when
  `user_id = auth.uid()`.
- **Every child table (`documents`, `quotations`, `issues`,
  `review_decisions`):** a person may act on a row only when **both**
  1. the row's `user_id = auth.uid()`, **and**
  2. the row's parent belongs to that same person — checked by looking up the
     parent (`review_id` → `reviews`; `quotation_id` → `quotations`; `issue_id` →
     `issues`) and confirming its owner is `auth.uid()`.
- **Preventing cross-user linking (the important part):** rule (2) is enforced on
  **insert and update** (an RLS `WITH CHECK`). That means a user cannot create or
  move a document/quotation/issue/decision so that it points at **another user's**
  review (or quotation, or issue) — the check fails because that parent is not
  theirs. So related records can only ever attach to the current user's own review.
- **Defense in depth:** the server also runs under the signed-in user's session
  (see `docs/architecture.md`), so even if an application check is missed, these
  database rules remain the enforcing boundary. **Decided:** on top of the RLS
  `WITH CHECK`, add **composite foreign keys** that force each child's `(parent,
  user_id)` / `(parent, review_id)` to match its parent — so owner and review stay
  consistent even under service-role access that bypasses RLS (see Rules for linked
  records).

### Rules for linked records (same review, same owner, correct document kind)

Beyond owner-only access, the links between records must stay internally consistent.
**Decided:** enforce "same owner" and "same review" with **composite foreign keys** at
the database level, alongside RLS. RLS protects user-session traffic but is bypassed by
service-role access; composite FKs make these invariants structurally true for *every*
writer. This covers **every** relationship:

- **Parents carry the keys the children point at.** Add `UNIQUE (id, user_id)` to
  `reviews`, `quotations`, and `issues`; add `UNIQUE (id, review_id)` to `quotations`
  and `issues`; add `UNIQUE (id, review_id, role)` to `documents` (this one supports the
  role-checking foreign keys below). `user_id` stays `NOT NULL` on every child.
- **Child → review (owner + review in one key):**
  `documents (review_id, user_id)`, `quotations (review_id, user_id)`, and
  `issues (review_id, user_id)` each reference `reviews (id, user_id)`. A row whose
  owner does not match its review's owner is rejected.
- **Issues → quotations (same review):** `issues (quotation_id, review_id)` references
  `quotations (id, review_id)`, so an issue can only attach to a quotation in the same
  review.
- **Decisions → issues (owner):** `review_decisions (issue_id, user_id)` references
  `issues (id, user_id)`. Decisions carry no `review_id`; their "same review" guarantee
  is transitive through the issue.
- **Report/transcript document links (same review *and* correct role). Decided — fold
  `role` into the composite key.** Each child carries a **fixed-value role column** and
  includes it in the foreign key, so the key checks same-review and document role in one
  rule:
  - `quotations` has `report_role`, pinned to `'report'`, and the composite key
    `quotations (report_document_id, review_id, report_role)` references
    `documents (id, review_id, role)`. A link can only resolve to a document in the same
    review whose `role` is `report`.
  - `issues` has `source_role`, pinned to `'transcript'`, and the composite key
    `issues (source_document_id, review_id, source_role)` references
    `documents (id, review_id, role)`. A link can only resolve to a transcript in the
    same review.
  - **Pinning the value:** each role column is `NOT NULL` and held to its one allowed
    value — e.g. a `CHECK (report_role = 'report')` with `DEFAULT 'report'`, or a
    generated column. `report_role` is always `'report'` and `source_role` is always
    `'transcript'`; the application never sets them to anything else and the database
    rejects any attempt.
  - **Evidence-free issues are still allowed — via a missing `source_document_id`
    alone.** An issue with no evidence (such as `quote_not_found`) leaves
    `source_document_id` empty (NULL). That NULL by itself disables the foreign key (SQL
    `MATCH SIMPLE`), so the row is accepted even though `source_role` stays `'transcript'
    NOT NULL`. Keeping `source_role` fixed means that **whenever** a `source_document_id`
    *is* present, the full same-review-and-transcript-role check always runs — there is no
    way to link a document while skipping the role check. (Exact-match quotations create
    **no issue row at all**, so they never reach this table.)
  - This reuses the existing composite-FK mechanism (no trigger), preserves the owner
    and same-review safeguards above, and holds even under service-role access that
    bypasses RLS.

**Verified against a local, disposable Supabase (synthetic data, 2026-11-06):**

- [x] RLS is turned on for every table.
- [x] Each table has a rule that lets people see only their own rows.
- [x] Each child table has a rule that blocks linking a row to another user's review.
- [x] I tested this with two accounts. One person could not see the other person's information.

*How tested:* the migration was applied to a local Supabase stack (`supabase start`), then
a synthetic two-user script ([`supabase/tests/rls_two_user_test.sql`](../supabase/tests/rls_two_user_test.sql),
see [`supabase/tests/README.md`](../supabase/tests/README.md) to re-run) confirmed owner-only visibility, two-user isolation, that
cross-review and owner-mismatch links are rejected (RLS `42501` and composite-FK
violations), document-role enforcement, that evidence-free `quote_not_found` issues are
accepted, and that deleting a review cascades to its children while another user's data
survives. **Not yet verified on hosted Supabase.**

## Deleting a review and its data

Deleting a review must remove the review and everything under it across **two
systems** — private Storage (the `.md` files) and the database (the records) — and a
database cascade does **not** touch Storage (TR-16, NFR-12). The order matters: if we
deleted the database records first, we would lose every `storage_path` and could no
longer find the files to delete, leaving orphaned objects we cannot retry. So the
`documents` rows (and their `storage_path` values) are **kept until the files are
confirmed gone**.

**Deletion sequence:**

1. **Mark the review as deleting (saved state).** Set `processing_status` to a
   `deleting` state (**assumption:** add this value) and **save it to the database**.
   This records that a delete is in progress so an interrupted delete can be resumed,
   and the review can be hidden from normal views. The `documents` rows and their
   `storage_path` values are **retained** from here until the files are confirmed gone.
2. **Block new uploads and processing for this review.** While `processing_status =
   'deleting'`, the review accepts **no new document uploads** and **no new or in-flight
   quotation processing** — those actions are refused for the review. This prevents a new
   file (and a new `storage_path`) from appearing after we have begun deleting, which
   could otherwise be missed. (Enforced by the application; **assumption:** optionally
   reinforced by a database rule/trigger that rejects inserts into `documents`/process
   state while the parent review is `deleting`.)
3. **Delete the Storage files, paths retained.** Using the `storage_path` of each
   `documents` row, delete the file objects from the private bucket. The database rows
   are **not** removed in this step, so every path is still available if a file
   deletion fails or is interrupted.
4. **Confirm every file is gone.** Proceed only after **every** file for the review is
   confirmed absent from Storage.
5. **Delete the database records.** Delete the `reviews` row; foreign keys set to
   **`ON DELETE CASCADE`** then remove its `documents`, `quotations`, `issues`, and
   (via `issues`) `review_decisions` in one step. (**Assumption:** cascade is the
   chosen mechanism.) This happens **only after** step 4.
6. **Confirm completion.** Deletion is reported as done only after both the files and
   the records are gone from active storage (NFR-12).

**Failure and retry (resolved).** Deletion is driven by **idempotent re-runs** rather
than a per-file progress column; a retry re-runs from step 3 over the retained
`documents` rows and **classifies each file's result**:

- **Already missing → treated as completed.** If Storage reports a file is not found
  (already deleted on an earlier attempt), count it as successfully gone and move on —
  deleting an absent file is harmless.
- **Genuine error → preserved for retry.** If a file deletion fails for any other reason
  (for example a permissions or network/transient error), that file is **not** counted
  as gone; the review stays `deleting` with its `documents` rows and paths intact, so a
  later retry attempts it again.

Step 4 passes only when every file is confirmed absent (each either deleted now or
already missing) and **no file is left in a genuine-error state**. If step 5 fails after
that, the files are already gone and the cascade can simply be re-run. At no point are
paths discarded before their files are removed. (A per-file progress flag on
`documents` is **not required** for correctness; it remains an optional future
optimization for very large reviews.)

Because each `documents` row stores the file's `storage_path`, the app always knows
exactly which Storage objects to delete — and keeps that information until the files
are actually gone. This is the practical reason the file-vs-record separation
matters.

---

# Database diagram

The entity diagram now lives in its own file:
**[`docs/database-diagram.md`](./database-diagram.md)** (GitHub renders the Mermaid
there). It is kept consistent with the tables above, which remain the authoritative
source for columns, types, allowed values, and constraints.

---

# Migration files

The initial schema is implemented by one migration (created, **not yet applied** to
Supabase):

- `supabase/migrations/20261105000000_init_research_quality_auditor_schema.sql` —
  creates the five tables, their `CHECK` constraints, the composite foreign keys
  (owner + review + role), supporting indexes, the `updated_at` trigger, and owner-only
  RLS policies.

- [x] Every change to my database is saved as a SQL migration file in my repository.
- [x] I can tell what each migration file does from its name.
- [x] The migration has been applied and tested on a **local** Supabase (synthetic data, 2026-11-06).
- [ ] The migration has been applied to **hosted** Supabase. *(Not done.)*

---

# Open product decisions, assumptions, and questions

**Kept open (not decided here):**

- **Acknowledgment persistence (open product decision).** Where/whether the
  data-handling acknowledgment (TR-19, UR-16, NFR-03) is recorded is **not decided**
  and is **not** modeled as a committed table above. *Options to weigh later:* a
  dedicated `acknowledgments` table (user_id, acknowledged_at, policy_version), or
  fields on `reviews`, or enforcing it only in the app. This stays open alongside
  the other open decisions in `docs/architecture.md`.
- All other open items from `docs/architecture.md` remain open: AI provider/model,
  per-quote classification cutoff, quality acceptance targets, upload limits,
  processing shape, and retention/backup policy.

**Assumptions made in this draft (confirm before the migration):**

- UUID primary keys; timestamps on every table.
- Exactly one `report` document per review; one or more `transcript` documents.
- Status/result/type values are enforced with `text` + `CHECK` (**decided**, not an
  enum); the value sets are finalized in the initial migration and can still evolve
  later via an ordinary constraint change.
- `ON DELETE CASCADE` is the deletion mechanism for database records, run only after
  Storage files are confirmed deleted.
- `user_id` is denormalized onto child tables for simpler, defensive RLS.
- A `deleting` `processing_status` value exists to support resumable deletion; while a
  review is `deleting`, new uploads and processing for it are blocked (app-enforced, with
  an optional reinforcing database rule).
- "Same owner" and "same review" are enforced with composite foreign keys on **every**
  relationship, alongside RLS — including issues→quotations and the report/transcript
  document links. Document **role** is folded into those links via fixed-value role
  columns (`quotations.report_role = 'report'`, `issues.source_role = 'transcript'`).
  This requires `UNIQUE (id, user_id)` on `reviews`/`quotations`/`issues`,
  `UNIQUE (id, review_id)` on `quotations`/`issues`, `UNIQUE (id, review_id, role)` on
  `documents`, and `NOT NULL` `user_id` on children.
- Role columns are `NOT NULL` and fixed (`report_role = 'report'`, `source_role =
  'transcript'`). Evidence-free issues (`quote_not_found`) are allowed by leaving
  `source_document_id` empty (NULL) alone, which disables the role-checking foreign key
  (`MATCH SIMPLE`); `source_role` stays `'transcript'`. Exact-match quotations create no
  issue row at all.

> **Resolved:** "Enforce allowed values with `CHECK` constraints or Postgres `enum`
> types?" is now **decided — `text` + `CHECK`** (see Allowed values), and the value
> sets are finalized in the initial migration.

> **Resolved:** "Add a trigger/constraint to force a child's `user_id` to match its
> parent's?" is now **decided — composite foreign keys** enforce matching owner *and*
> review across every relationship, alongside RLS (see Rules for linked records).

> **Resolved:** quotation location is stored as two integer columns, `start_offset` /
> `end_offset` (zero-based Unicode code points, half-open `[start, end)`), verified
> against `original_text` at write time (see the quotations table).

> **Resolved:** the diagram now lives in its own file,
> [`docs/database-diagram.md`](./database-diagram.md). A Supabase Schema Visualizer
> screenshot may still be added there once the tables exist.
>
> **Resolved:** document-role enforcement on links is **decided — fold `role` into the
> composite foreign key** via fixed-value role columns (`report_role`, `source_role`);
> see Rules for linked records. No trigger needed; evidence-free issues stay allowed.
>
> **Resolved:** deletion **relies on idempotent re-runs**, not a per-file progress
> column. The `deleting` status is saved and `documents` rows/paths are retained until
> all files are confirmed gone; new uploads and processing are blocked while deleting; on
> retry an already-missing file counts as completed while a genuine error is preserved
> for retry; database records are cascaded only after every file is gone (see Deleting a
> review and its data). A per-file progress flag stays an optional future optimization.

_No open questions remain in this document. Remaining open items live in
`docs/architecture.md` (AI provider/model, per-quote classification cutoff, quality
targets, upload limits, processing shape, retention/backup) and the acknowledgment-
persistence product decision noted above._
