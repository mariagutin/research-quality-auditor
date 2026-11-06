# Database diagram — Research Quality Auditor (MVP #1)

> **Draft** entity diagram (Mermaid), kept consistent with
> [`docs/database-design.md`](./database-design.md) — the authoritative source for
> columns, types, allowed values, and constraints. GitHub renders Mermaid. Timestamp
> columns (`created_at` / `updated_at`) are omitted here for readability; see the design
> doc for the full column list. **Open question / deliverable:** this may later be
> supplemented with a screenshot from Supabase's Schema Visualizer once the tables
> exist.
>
> The fixed-value columns `quotations.report_role` and `issues.source_role` are part of
> the composite foreign keys that force report links to point at a `report` document and
> evidence links at a `transcript`, within the same review (see the design doc's "Rules
> for linked records").

```mermaid
erDiagram
    auth_users ||--o{ reviews : owns
    reviews ||--o{ documents : has
    reviews ||--o{ quotations : has
    reviews ||--o{ issues : has
    documents ||--o{ quotations : "report source of"
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
      text processing_status
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
```
