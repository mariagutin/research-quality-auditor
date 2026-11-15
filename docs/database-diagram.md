# Database diagram — Research Quality Auditor (MVP #1)

> **Draft** entity diagram (Mermaid), kept consistent with
> [`docs/database-design.md`](./database-design.md) — the authoritative source for
> columns, types, allowed values, and constraints. GitHub renders Mermaid. Plain
> `created_at` / `updated_at` columns are omitted here for readability; see the design
> doc for the full column list. **Open question / deliverable:** this may later be
> supplemented with a screenshot from Supabase's Schema Visualizer once the tables
> exist.
>
> The fixed-value columns `quotations.report_role`, `quotations.matched_role`, and
> `issues.source_role` are part of the composite foreign keys that force report links to
> point at a `report` document and evidence links (the quotation's matched transcript and
> an issue's source) at a `transcript`, within the same review (see the design doc's
> "Rules for linked records"). A quotation's `matched_document_id`/`matched_excerpt`
> record WHERE a verified quote was found; both are null for an unmatched quote.
>
> **Operation lifecycle (migration `20261112000000`).** `reviews` carries a per-attempt
> operation lease (`op_token`, `op_heartbeat_at`, `op_failed_at`) and an expanded
> `processing_status` set (adds `uploading`). Two owner-only bookkeeping tables track
> Storage cleanup: `review_dead_upload_attempts` — one row per retired upload-attempt
> folder, with a composite FK to `reviews` — and `review_file_cleanups`, a whole-prefix
> record that **deliberately has no FK to `reviews`** so it outlives a deleted review row
> (hence no edge to `reviews` below; it links only to the owner). `database-design.md`
> is pending an update to match.

```mermaid
erDiagram
    auth_users ||--o{ reviews : owns
    auth_users ||--o{ review_file_cleanups : "owns (outlives review)"
    reviews ||--o{ documents : has
    reviews ||--o{ quotations : has
    reviews ||--o{ issues : has
    reviews ||--o{ review_dead_upload_attempts : "retired upload attempts"
    documents ||--o{ quotations : "report source of"
    documents ||--o{ quotations : "matched transcript of"
    documents ||--o{ issues : "evidence source of"
    quotations ||--o{ issues : "flagged in"
    issues ||--o| review_decisions : "zero or one"

    auth_users {
      uuid id PK
    }
    reviews {
      uuid id PK
      uuid user_id FK
      text name
      text processing_status "draft/uploading/processing/complete/failed/deleting"
      uuid op_token
      timestamptz op_heartbeat_at
      timestamptz op_failed_at
    }
    documents {
      uuid id PK
      uuid review_id FK
      uuid user_id FK
      text role
      text filename
      text storage_path
      text participant_id
      text validation_status
    }
    quotations {
      uuid id PK
      uuid review_id FK
      uuid report_document_id FK
      text report_role
      uuid user_id FK
      text original_text
      text listed_participant_id
      integer start_offset
      integer end_offset
      text checking_result
      uuid matched_document_id FK
      text matched_role
      text matched_excerpt
    }
    issues {
      uuid id PK
      uuid review_id FK
      uuid quotation_id FK
      uuid user_id FK
      text issue_type
      text explanation
      uuid source_document_id FK
      text source_role
      text source_excerpt
    }
    review_decisions {
      uuid id PK
      uuid issue_id FK
      uuid user_id FK
      text decision
    }
    review_dead_upload_attempts {
      uuid review_id PK
      uuid token PK
      uuid user_id FK
    }
    review_file_cleanups {
      uuid id PK
      uuid user_id FK
      uuid review_id
      text prefix
      timestamptz finalized_at
    }
```
