# Development Checklist — Research Quality Auditor

Adapted from the course "Build and Launch Checklist." Task numbering and wording
are preserved; only the project name/repository are adapted to this project.

- **Assessed:** 2026-11-06 (re-checked after the hosted Supabase project was
  created and the Data API grants migration was added)
- **Scope note:** A hosted Supabase project now exists — you created it on
  2026-11-06 and disabled "Automatically expose new tables" — but **nothing has
  been applied to it yet** (no schema, no data). All work in this repo remains
  **local-only** by instruction: migrations are tested against a local,
  disposable stack, never hosted. Deployment items remain out of scope.
- **How to read status:** `[x]` = verified complete with evidence in this repo.
  `[ ]` = not done, partial, or not verifiable from the repo. Each item has a
  short *Status* note with the evidence or the reason. ⚠️ marks a conflict or
  something to confirm.

---

## Set up your accounts and tools

- [ ] **1. Make your free Vercel and Supabase accounts.** Sign up for each one
  with your GitHub account. Pick the free plan on each one. You already set up
  Claude Code and GitHub in Week 1.
  - *Status: Partial.* **Supabase:** you confirmed creating a hosted project on
    2026-11-06, so the account exists (not independently verifiable from the repo,
    and the CLI is not linked — `linked_project` is null). **Vercel:** still
    unverified (ADR-0002 records the decision to use it, but no account evidence).
    Left unchecked because both accounts are required and the Vercel one isn't
    confirmed.

- [x] **2. Check that your computer is ready.** Open Claude Code in the folder
  for this project. Ask Claude to check that Node.js is installed.
  - *Status: Verified.* Node.js **v26.13.0** is installed, and this project is
    open in Claude Code. Docker + the local Supabase stack also run.

- [ ] **3. Gather your saved documents** (vision, scope, requirements, build
  plan from Week 2) to give Claude at the start of each chat.
  - *Status: Partial / outside the repo.* `docs/architecture.md` cites a
    confirmed scope, User Requirements (UR), Technical Requirements (TR), NFRs,
    and a "Build Plan," so these inputs clearly exist — but ⚠️ the source
    documents themselves are **not stored in this repo**, so completion can't be
    verified. Consider saving them under `docs/`.

## Build the app on your computer

- [x] **4. Make the project.** A new Next.js app using Material UI, in the
  GitHub repository, with the first version pushed.
  - *Status: Verified.* `app/` (Next.js + MUI), `package.json` (`next`,
    `@mui/material`), commit `8339a39` "Add Next.js + TypeScript + MUI starter,"
    pushed to `origin/main`. ⚠️ The checklist names the repo "Week 3 - Research
    Quality Auditor research-quality-auditor"; the actual GitHub repo is
    **`research-quality-auditor`**. Cosmetic difference — confirm it's intended.

- [x] **5. Architect the app.** Plan the screens (tier 1), the server code
  (tier 2), and the database (tier 3), written in a document in the repo before
  code.
  - *Status: Verified.* `docs/architecture.md` has a "The three tiers" section
    covering Tier 1 (Next.js + MUI screens), Tier 2 (server logic on Vercel), and
    Tier 3 (Supabase), plus a data model and an end-to-end walkthrough.

- [x] **6. Write down your big decisions as ADRs** in `docs/adr`, one per big
  choice (Next.js + MUI, Vercel, Supabase).
  - *Status: Verified.* `docs/adr/0001-use-nextjs-with-material-ui.md`,
    `0002-host-on-vercel.md`, `0003-use-supabase.md`.

- [x] **7. Design your database tables.** Save them as a migration file and turn
  on access rules (RLS) for every table.
  - *Status: Verified.* `supabase/migrations/20261105000000_init_research_quality_auditor_schema.sql`
    creates all five tables with `enable row level security` on every one, plus
    owner-only policies and composite FKs. `docs/database-design.md` documents
    the design, and `supabase/tests/rls_two_user_test.sql` passes against the
    local stack. (Verified locally only; not on hosted Supabase.) A follow-up
    migration, `20261106000000_grant_data_api_access_to_authenticated.sql`, adds
    the table grants the signed-in workflow needs — see item 8.

- [ ] **8. Connect the app to Supabase.** Make a hosted Supabase project (free
  plan), run the SQL there (SQL Editor or connected CLI), save the SQL as a
  migration file, and put your Supabase keys in `.env.local`.
  - *Status: Partial.* ✅ A hosted Supabase project now exists (you created it,
    free plan, 2026-11-06). ✅ The SQL is saved as migrations
    (`20261105000000_init…` and `20261106000000_grant_data_api_access…`, the
    latter adding the grants the signed-in workflow needs when "Automatically
    expose new tables" is off — verified locally by `grants_data_api_test.sql`).
    ⬜ The migrations have **not** been run on the hosted project, the CLI is
    **not linked** (`linked_project` is null), and there is **no `.env.local`**
    with keys. These remain for when hosted work is authorized.

- [ ] **9. Build one feature at a time.** Start with sign-up / log-in, then each
  MVP #1 feature; write a new ADR for any new big choice.
  - *Status: Not started.* `app/` is still the starter (`page.tsx` states
    "Authentication, uploads, and quotation checking come in later steps"). No
    authentication or feature code yet. The database foundation (item 7) is in
    place, but no user-facing feature is built.

- [ ] **10. Run and test the app on your computer.** Click through every screen,
  make two test accounts, and confirm one person cannot see another's
  information.
  - *Status: Partial.* ✅ **Database-level** two-user isolation is verified by
    `supabase/tests/rls_two_user_test.sql` (owner-only visibility, cross-user
    blocks, cascade). ⬜ **App-level** click-through and two real sign-in
    accounts aren't possible yet because the features in item 9 don't exist.

## Launch it on the internet

> The three items below require deployment / hosted services and are **out of
> scope** under the current local-only restriction. Left unchecked by design.

- [ ] **11. Connect your GitHub repository to Vercel** and add your Supabase
  keys in Vercel's environment settings.
  - *Status: Not started (out of scope — deployment).*

- [ ] **12. Push your code and let Vercel publish it.**
  - *Status: Not started (out of scope — deployment).*

- [ ] **13. Test the live app** (Vercel URL, every MVP #1 feature, and on your
  phone).
  - *Status: Not started (out of scope — deployment).*

- [ ] **14. Save what you learned.** Have Claude write down what you built and
  decided, save it in the repo, then fill out the Submission Template yourself,
  without AI.
  - *Status: Not started.* Design/decision docs exist (`architecture.md`, ADRs),
    but there is no "what we built / what we decided" build summary, and the
    Submission Template is yours to complete without AI.

## Move your tickets as you work

> These refer to the Week 2 Backlog Kanban Board, which lives outside this repo
> and can't be verified here.

- [ ] Open the Backlog Kanban Board you made in Week 2.
- [ ] When you start a ticket, move it to **In Progress**.
- [ ] When the feature works on your live app, move it to **Done**.
- [ ] You are finished when every MVP #1 ticket is in **Done**.
  - *Status: Unknown — tracked outside the repo.*

---

## Summary of flags / conflicts

- **Item 1:** Supabase account confirmed by you (hosted project created); Vercel
  account still unverified. **Item 3, Kanban:** process/external steps that can't
  be verified from the repo — confirm yourself.
- **Item 3:** ⚠️ the Week 2 source documents (vision, scope, requirements, build
  plan) are referenced by `architecture.md` but not stored in the repo.
- **Item 4:** ⚠️ repo-name wording in the checklist
  ("Week 3 - Research Quality Auditor research-quality-auditor") vs. the actual
  repo name `research-quality-auditor`.
- **Item 8:** partial — hosted project created and SQL saved as migrations
  (including the Data API grants migration); hosted SQL run, CLI link, and
  `.env.local` not done (deferred by the local-only restriction).
- **Items 9–13:** app features and deployment not started; item 10 is only
  partially met (database-level isolation only).
