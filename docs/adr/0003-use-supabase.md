# ADR-0003: Use Supabase for accounts, records, and private files

## Date and status
[Decision date — please confirm]. Accepted.

> Supabase (Auth, PostgreSQL, and Storage) was specified in the Week 2 Technical
> Build Plan. The Options below record the reasoning behind the choice. No formal
> evaluation of alternatives is documented.
>
> [Confirm: is Supabase a course requirement? If so, note that here.]

## Context
The app needs three back-end capabilities: user accounts with sign-in/out
(UR-10, TR-15), structured records (reviews, documents, quotations, issues,
decisions), and storage for the uploaded `.md` files. A hard requirement is that
each researcher can reach only their own documents, participant IDs, results,
decisions, and files (TR-15, NFR-01). We decided that ordinary requests run under
the signed-in user's own session and that owner-only access is enforced in the
database itself, so the back end needs to support that model well (see
`docs/architecture.md` → Access control).

## Options

- Supabase (managed Auth + PostgreSQL + Storage):
  - Good: Provides all three capabilities in one service; PostgreSQL row-level
    security (RLS) lets us enforce owner-only access at the database layer, which
    matches our access-control decision; private storage buckets with owner-only
    policies; works from both browser and server with the user's session.
  - Bad: Security depends on writing RLS and storage policies correctly — a weak
    policy is a real risk; it is another managed service to depend on.
- Build our own auth, database, and file storage:
  - Good: Full control over every detail.
  - Bad: We would build and secure authentication, sessions, and access rules
    ourselves — slow and risky for an MVP, and the most security-sensitive part to
    get wrong.
- Another backend-as-a-service (for example Firebase):
  - Good: Also bundles auth, database, and storage with little setup.
  - Bad: Its document database and rules model is a different shape from the
    relational records and SQL-based RLS we want for reviews/issues/decisions, so it
    fits our data model and access approach less directly.

## Decision
Use **Supabase** for Auth, PostgreSQL, and private file Storage, because it covers
all three back-end needs in one place and its PostgreSQL row-level security lets us
enforce owner-only access in the database — the enforcing boundary our architecture
relies on, rather than trusting application code alone.

## Consequences
- We must author RLS policies on every records table and owner-only policies on the
  private storage bucket, and test them; access control is only as strong as these
  policies.
- Database schema and migrations live in the GitHub repository alongside the code.
- Uploaded `.md` files go in a private bucket, never public (TR-15, NFR-01).
- Any need for elevated (service-role) access that bypasses RLS is deliberately left
  as a **separate decision to document and justify**, not a default (see
  `docs/architecture.md`).
- Related decisions stay open and are not settled here: where the data-handling
  acknowledgment is persisted, and the deletion/retention guarantees (NFR-12). The
  choice of **AI provider** is a separate, still-open decision and is not part of
  this ADR.
- Next steps: create the schema and RLS migration, and wire Supabase Auth into the
  interface and server logic.
