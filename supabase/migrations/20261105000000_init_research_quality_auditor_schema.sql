-- Migration: initial schema for Research Quality Auditor (MVP #1)
-- Created: 2026-11-05
--
-- Implements docs/database-design.md and docs/database-diagram.md:
--   * Five application tables: reviews, documents, quotations, issues,
--     review_decisions.
--   * Status / result / issue-type / role / decision values as text columns with
--     CHECK constraints (decided: text + CHECK, not Postgres enum).
--   * Composite foreign keys that enforce same-owner, same-review, and (for document
--     links) correct document role -- structurally, alongside RLS.
--   * Owner-only Row Level Security on every table.
--
-- Intentionally NOT included here (unresolved product/architecture decisions, kept
-- open on purpose -- see docs/architecture.md and the design doc):
--   * acknowledgments of the data-handling notice (persistence undecided);
--   * the private Storage bucket and its access policies (depend on the still-open
--     upload-path and upload-limit decisions) -- a later migration once decided;
--   * AI provider/model, quality targets, processing shape, retention/backup.
--
-- Deletion of a review's Storage files, and blocking new uploads/processing while a
-- review is in the `deleting` state, are application-enforced (see the design doc).
-- An optional reinforcing database rule for that block is deliberately omitted here.
--
-- NOTE: this file has been created but NOT applied to Supabase.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- reviews: one quotation-checking job, owned by one researcher.
create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  processing_status text not null default 'draft'
    check (processing_status in ('draft', 'processing', 'complete', 'failed', 'deleting')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- target for child -> review composite FKs (owner + review in one key)
  constraint reviews_id_user_id_key unique (id, user_id)
);

-- documents: the record describing one uploaded file (report or transcript).
-- The file bytes live in private Storage; storage_path points at them.
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null,
  user_id uuid not null,
  role text not null check (role in ('report', 'transcript')),
  filename text not null,
  storage_path text not null,
  participant_id text,
  validation_status text not null default 'pending'
    check (validation_status in ('pending', 'valid', 'invalid')),
  created_at timestamptz not null default now(),
  -- target for the role-checking document-link FKs below
  constraint documents_id_review_id_role_key unique (id, review_id, role)
);

-- quotations: one quotation extracted from the report, plus its overall result.
create table public.quotations (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null,
  report_document_id uuid not null,
  -- fixed-value column pinned to 'report'; part of the role-checking FK
  report_role text not null default 'report' check (report_role = 'report'),
  user_id uuid not null,
  original_text text not null,
  listed_participant_id text,
  -- zero-based Unicode code-point offsets, half-open [start_offset, end_offset).
  -- Lower bound and ordering enforced here; the upper bound (<= report length) and
  -- "sliced text equals original_text" are verified in application at write time.
  start_offset integer not null,
  end_offset integer not null,
  checking_result text not null
    check (checking_result in ('no_issues', 'has_issues')),
  created_at timestamptz not null default now(),
  constraint quotations_offsets_check check (start_offset >= 0 and start_offset < end_offset),
  constraint quotations_id_review_id_key unique (id, review_id),
  constraint quotations_id_user_id_key unique (id, user_id)
);

-- issues: one individual issue found for one quotation.
create table public.issues (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null,
  quotation_id uuid not null,
  user_id uuid not null,
  issue_type text not null
    check (issue_type in ('wording_mismatch', 'participant_mismatch',
                          'participant_not_specified', 'quote_not_found')),
  explanation text,
  -- evidence transcript (optional): NULL for quote_not_found. A NULL here disables
  -- the role-checking FK below (MATCH SIMPLE), so evidence-free issues are allowed.
  source_document_id uuid,
  -- fixed-value column pinned to 'transcript'; kept NOT NULL so that whenever a
  -- source_document_id IS present, the transcript-role check always runs.
  source_role text not null default 'transcript' check (source_role = 'transcript'),
  source_excerpt text,
  created_at timestamptz not null default now(),
  constraint issues_id_user_id_key unique (id, user_id),
  constraint issues_id_review_id_key unique (id, review_id)
);

-- review_decisions: zero or one current decision per issue (UNIQUE issue_id).
create table public.review_decisions (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null unique,
  user_id uuid not null,
  decision text not null
    check (decision in ('needs_correction', 'dismiss', 'investigate')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Composite foreign keys: same owner, same review, correct document role.
-- Added after all tables + unique targets exist.
-- ---------------------------------------------------------------------------

-- documents -> reviews (owner + review)
alter table public.documents
  add constraint documents_review_fk
  foreign key (review_id, user_id)
  references public.reviews (id, user_id) on delete cascade;

-- quotations -> reviews (owner + review)
alter table public.quotations
  add constraint quotations_review_fk
  foreign key (review_id, user_id)
  references public.reviews (id, user_id) on delete cascade;

-- quotations.report_document_id must be a 'report' document in the same review
alter table public.quotations
  add constraint quotations_report_document_fk
  foreign key (report_document_id, review_id, report_role)
  references public.documents (id, review_id, role) on delete cascade;

-- issues -> reviews (owner + review)
alter table public.issues
  add constraint issues_review_fk
  foreign key (review_id, user_id)
  references public.reviews (id, user_id) on delete cascade;

-- issues -> quotations (same review)
alter table public.issues
  add constraint issues_quotation_fk
  foreign key (quotation_id, review_id)
  references public.quotations (id, review_id) on delete cascade;

-- issues.source_document_id, when present, must be a 'transcript' in the same review.
-- NULL source_document_id => FK not enforced (MATCH SIMPLE) => evidence-free issue.
alter table public.issues
  add constraint issues_source_document_fk
  foreign key (source_document_id, review_id, source_role)
  references public.documents (id, review_id, role) on delete cascade;

-- review_decisions -> issues (owner); same-review is transitive through the issue
alter table public.review_decisions
  add constraint review_decisions_issue_fk
  foreign key (issue_id, user_id)
  references public.issues (id, user_id) on delete cascade;

-- ---------------------------------------------------------------------------
-- Indexes on child FK columns (the composite unique constraints index the parent
-- side; these help joins and RLS lookups on the child side).
-- ---------------------------------------------------------------------------

create index reviews_user_id_idx on public.reviews (user_id);
create index documents_review_id_idx on public.documents (review_id);
create index documents_user_id_idx on public.documents (user_id);
create index quotations_review_id_idx on public.quotations (review_id);
create index quotations_user_id_idx on public.quotations (user_id);
create index quotations_report_document_id_idx on public.quotations (report_document_id);
create index issues_review_id_idx on public.issues (review_id);
create index issues_user_id_idx on public.issues (user_id);
create index issues_quotation_id_idx on public.issues (quotation_id);
create index issues_source_document_id_idx on public.issues (source_document_id);
create index review_decisions_user_id_idx on public.review_decisions (user_id);

-- ---------------------------------------------------------------------------
-- updated_at maintenance (only tables that have updated_at)
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger reviews_set_updated_at
  before update on public.reviews
  for each row execute function public.set_updated_at();

create trigger review_decisions_set_updated_at
  before update on public.review_decisions
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security: owner-only on every table.
-- For child tables, INSERT/UPDATE (WITH CHECK) also verify the parent is owned by
-- the caller, preventing cross-user linking. The composite FKs above enforce the
-- same invariants structurally (even under service-role access that bypasses RLS).
-- ---------------------------------------------------------------------------

alter table public.reviews enable row level security;
alter table public.documents enable row level security;
alter table public.quotations enable row level security;
alter table public.issues enable row level security;
alter table public.review_decisions enable row level security;

create policy reviews_owner_all on public.reviews
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy documents_owner_all on public.documents
  for all to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.reviews r
      where r.id = documents.review_id and r.user_id = auth.uid()
    )
  );

create policy quotations_owner_all on public.quotations
  for all to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.reviews r
      where r.id = quotations.review_id and r.user_id = auth.uid()
    )
  );

create policy issues_owner_all on public.issues
  for all to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.reviews r
      where r.id = issues.review_id and r.user_id = auth.uid()
    )
  );

create policy review_decisions_owner_all on public.review_decisions
  for all to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.issues i
      where i.id = review_decisions.issue_id and i.user_id = auth.uid()
    )
  );
