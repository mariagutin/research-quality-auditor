# ADR-0009: CI pipeline on GitHub Actions (five jobs)

## Date and status
Decided 2026-11-14. **Accepted and implemented.** Status as of 2026-11-20 (earlier
statuses are in "Revision history" below):

- **Committed and pushed.** Committed on branch `week-5-cicd` in `249e731`
  (2026-11-16) and pushed to GitHub. The pipeline has run on every push since.
- **Failure-and-recovery demonstration completed** (2026-11-16) on the Skill checks
  job. `a371478` removed the `ux-review` description, and only Skill checks failed
  (run 43973229896). `36f8ad6` restored it, and all five jobs passed again
  (run 43973504435).
- **Up to date with `main`.** `main`, including the Results screen redesign
  (PR #2), was merged into `week-5-cicd` in `5a98c74` (2026-11-20) and pushed. All
  five jobs passed on both the push run (44804104441) and the pull-request run
  (44805431829).
- **Merged into `main`.** PR #3 (`week-5-cicd` → `main`) was merged on 2026-11-20
  in `c8be4fe`, and the CI run on `main` passed all five jobs (run 44811346167). The
  workflow is now on `main`, so it also runs on pushes to branches created from it.

> Week 5 quality-assurance work. Builds on the MVP quotation-verification
> requirements (TR-08, TR-09, NFR-04) and the wording-difference rule (ADR-0006).

## Context
**Outcome wanted:** *every time code is pushed, GitHub Actions runs checks that
prove the MVP quotation-checking behavior still works (from the Week 2 use cases /
BDD scenarios) and that the code still builds/lints/typechecks — so tested problems
are caught before merging and deploying,* and later the same gate covers the Week 1
Claude Skills. On the free plan, branch protection isn't required; "red means don't
merge yet."

## Decision

### 1. One workflow, five separately-named jobs
`.github/workflows/ci.yml` runs on **`push`** and **`pull_request`**. It defines
**five independent jobs** (parallel, each its own runner and clear pass/fail in the
Actions tab and on PRs): **Lint**, **Typecheck**, **Unit tests (quotation
scenarios)**, **Build (production compilation)**, and **Skill checks (structure +
references)** (§6, added 2026-11-16 when the skills gate-check under "Open /
deferred" was resolved). Separate jobs (not steps in one
job) were chosen so each check has a distinct, legible result; the cost is each job
re-runs `npm ci`, acceptable at this size. Each job: `actions/checkout@v4` →
`actions/setup-node@v4` (**Node 22**, npm cache) → `npm ci` → its one command.

**Node 22** matches the repo (`@types/node ^22`) and is within Next 15's supported
range; the repo declares no `engines`, and the local machine's Node 26 is not a
standard CI target.

### 2. What each check verifies / fails on
- **Lint — `npm run lint` (`next lint`).** Verifies the code obeys ESLint
  (`next/core-web-vitals`). Fails on any ESLint **error** (hook-rule violations,
  undefined refs, unsafe patterns). *Currently clean — no app-code changes were
  needed.*
- **Typecheck — `npm run typecheck` (`tsc --noEmit`).** Verifies the whole project
  type-checks. Fails on any type error.
- **Unit tests — `npm run test:unit`.** Runs **five** test files one after another
  (`tsx … && tsx …`), so the job fails if any one of them fails. The job's name,
  "Unit tests (quotation scenarios)", is narrower than what it runs. All five call
  pure functions with in-memory data, with no DB, Storage, Docker, network, or env
  (§4):
  1. `scripts/ci/quotation-scenarios.test.mts` (10 checks): the two BDD scenarios
     against `analyzeReport`. *Participant mismatch*: a quote credited to P03 but
     verbatim only in P05 gives a single `participant_mismatch` with P05's passage
     and source document. *Quote not found*: no exact match and no ≥0.70/≥4-word
     match gives `quote_not_found`, with **no** source passage and nothing
     invented.
  2. `scripts/ci/turn-matching.test.mts` (15 checks): full-turn parsing, speaker
     boundaries, moderator exclusion, ordinary colons, shorter source passages, the
     fitting-alignment candidate window, and the distant-word regression (ADR-0006).
  3. `scripts/ci/result-state.test.mts` (8 checks): the three results states the
     review page chooses between, which are `no_quotations` (TR-18), `no_issues`
     (TR-17), and `has_issues`.
  4. `scripts/ci/action-gating.test.mts` (36 checks): the review page's action
     gating. This includes the fail-safe case where `review_op_active` is
     unavailable, so Delete is disabled, Run check is hidden, and a retry is shown.
  5. `scripts/ci/list-status.test.mts` (34 checks): the review-status chips on
     *Your checks*. Covers the five labels for completed checks, unchanged statuses
     for unfinished ones, counts matching the review page's own counting (ADR-0007),
     and reading every row despite the API's per-request row limit.

  The check counts are the `PASS` lines from local runs on 2026-11-20 (103 in
  total). The job fails if the matching, results-state, gating, or list-status
  logic regresses.
  The quotation scenarios were recorded here as the **break-it-on-purpose
  target**. The demonstration actually performed (2026-11-16) broke the **Skill
  checks** job instead (see "Date and status").
- **Build — `npm run build` (`next build`).** A **production-compilation** check
  using the same `next build` command Vercel runs when it builds the app (routes
  build, server/client boundaries valid, imports resolve). It runs on GitHub's
  runners with placeholder public env values (§5) and **deploys nothing**. §7 covers
  how it differs from Vercel's preview deployment. It **also lints and type-checks**
  (Next's default), so it
  fails on a production build error, a type error, **or** a lint error — overlapping
  the Lint/Typecheck jobs on purpose (defense-in-depth): the dedicated jobs give
  fast, clearly-labeled feedback, and the build proves those same checks hold in the
  real production compile.

### 3. Tooling added (pinned to the installed Next 15.5.29)
- `eslint ^8.57.1` + `eslint-config-next@15.5.29` (same version as the installed
  Next) + `.eslintrc.json` → `{ "extends": "next/core-web-vitals" }`.
- `tsx ^4.20.0` as a **devDependency** (so CI runs the unit tests from
  `node_modules` via `npm ci`, not an on-the-fly `npx` fetch).
- `package.json` scripts: `typecheck`, `test:unit`, and later `test:skills` (§6).
- `next.config.mjs` is left at its default, so `next build` **retains ESLint +
  type-checking** during the production compile (in addition to the dedicated Lint
  and Typecheck jobs).

### 4. Why the unit tests are pure (no Supabase in CI)
`analyzeReport` is a pure function; importing `lib/reviews/run-check.ts` is
side-effect-free (pure `text-compare` helpers + a type-only Supabase import; no
client created at import). The CI test calls it with in-memory text — **no DB,
Docker, network, or env**. The existing `scripts/*.local-test.mts` and
`supabase/tests/*.sql` (integration + SQL) need a running Supabase stack and are
**not** in CI for now; they stay local. A Supabase-in-CI job for those is a possible
later addition.

### 5. Build placeholder env
The Build job sets placeholder **public** values (`NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`) so the client factory has what it needs at
build time. They are not secrets and never reach a real database.

### 6. Skill checks — structural validation of the vendored Week 1 skills

**Resolved 2026-11-16** (the "Week 1 Claude Skills gate-check" open item below).
Morgan confirmed the three Week 1 skills should become CI checks **in this app
repo**. Approach:

- **Vendored copies.** The three skills (`accessibility-audit`,
  `research-interview-coach`, `ux-review`) are copied **verbatim** from
  `mariagutin/AI-Development-Residency` (`.claude/skills/`, commit
  `ac98a7bb4f0f336dfc6977f7cd93d4ed7170a298`) into this repo's `.claude/skills/`, so
  the check runs on in-repo files with no cross-repo fetch at CI time. Provenance and
  byte-for-byte blob-SHA equality are recorded in `.claude/skills/README.md`. The
  trade-off is **drift**: a copy can fall behind upstream; re-vendoring refreshes it.
- **Structural validation only.** `scripts/ci/skill-structure.test.mts`
  (`npm run test:skills`, job **Skill checks**) checks, per skill: a `SKILL.md`
  exists; its `---`-fenced frontmatter parses as YAML (via the `yaml` package — a
  proper parser, not a hand-rolled reader); `name` and `description` are present and
  non-empty; `name` ≤ 64 chars, lowercase letters/numbers/hyphens, no reserved word
  (`anthropic`/`claude`), no XML tag; `description` ≤ 1024 chars, no XML tag; and
  every relative reference link in the body resolves to an existing file inside the
  skill folder. The XML-tag rule matches a real tag (`<tag>`), **not** every angle
  bracket, so `>=` or `< 5` pass.
- **Rule sources (Anthropic Agent Skills format, verified 2026-11-16).** The required
  fields and the 64 / 1024 limits and character rules are from the official docs, not
  invented:
  - Overview — https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
  - Best practices — https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices

  (Claude Code's own docs treat `name`/`description` as optional; we enforce the
  stricter published format, which all three skills satisfy.) **No "required section"
  rule is imposed** — the three skills share no common heading structure, so requiring
  specific sections would be invented.
- **Scope boundary.** This validates the skill **files** (structure, metadata,
  reference-link integrity), **not** the skills' outputs or effectiveness. Evaluating
  what a skill actually produces would need AI-based evaluation — a separate, optional
  track that does **not** conflict with the app's deterministic quotation checker
  (ADR-0010): the two concern different artifacts.
- **Dependency added.** `yaml` (v2) as a devDependency, so the validator parses
  frontmatter with a real YAML parser under `npm ci`.

### 7. GitHub CI verification vs. Vercel preview deployment

Two separate systems report results on commits and pull requests:

- **GitHub CI (this ADR)** runs the five jobs in `.github/workflows/ci.yml` on
  GitHub's runners. It **verifies** the code by running lint, types, unit tests,
  skill structure, and a production compile with placeholder values. It deploys
  nothing and never connects to a real database. Its results appear as the five
  named checks.
- **Vercel preview deployment** comes from Vercel's own Git integration. That
  integration is configured in the Vercel project, not in this repo, which has no
  `vercel.json`. When a branch is pushed, Vercel builds the app with the Vercel
  project's environment variables and publishes a preview URL. It reports back as
  the **Vercel** commit status and the **Vercel Preview Comments** check, as
  observed for `36f8ad6` and `5a98c74`.
- **Build command.** The repo's `npm run build` runs `next build`, and in the
  current configuration (`next.config.mjs` is empty, so Next's defaults apply)
  `next build` runs with linting and type checking enabled. A lint or type error
  therefore fails that build. **Not verified:** whether the Vercel project
  overrides its build command at the project level. If it uses the repo's build,
  as Vercel does for Next.js by default, its builds lint and type-check too.
- **What each one shows.** A green CI run shows the code passes the five checks,
  but not that a preview deployment works. A successful Vercel preview shows the
  app built and was deployed on Vercel. Vercel doesn't run our separate
  `test:unit` or `test:skills` commands, so unit-test and skill-check results come
  only from GitHub CI. Which Supabase project a preview connects to depends on
  Vercel's environment settings, which this ADR doesn't record.
- **Unchanged by this ADR.** Vercel's deployment settings were left as they were,
  and CI has no deploy step.

## Open / deferred
- **Week 1 Claude Skills gate-check — RESOLVED 2026-11-16.** Morgan confirmed the
  three skills become CI checks in this app repo; implemented as the **Skill checks**
  job over vendored copies with structural validation — see **§6** above. A richer,
  **AI-based evaluation of skill *outputs*** remains a possible future track, separate
  from this file-structure check.
- **Branch protection** not enabled (free plan).

## Consequences
- Five requirement-tied checks run on every push; the quotation-scenario tests tie
  CI straight back to the MVP requirements, and the Skill checks job now validates the
  vendored Week 1 skills. Well past the ≥3-new-checks homework bar.
- `next lint` prints a deprecation notice (to be removed in Next 16); it works on
  15.5.29. A future migration to the ESLint CLI is noted, not done.
- CI covers only pure/fast checks today; database-touching tests remain local until a
  Supabase-in-CI job is justified.

## Revision history
- **2026-11-14:** Decision written. Title "four checks". Status "implemented
  locally on branch `week-5-cicd`; **not committed, pushed, or deployed** yet".
- **2026-11-16:** §6 Skill checks added, making five jobs (§1 updated; the title
  still said "four checks"). Committed in `249e731` and pushed. The
  failure-and-recovery demonstration was completed the same day.
- **2026-11-20:** Brought up to date without changing any decision:
  - Title changed from "four checks" to "five jobs".
  - Status rewritten to cover the commit, push, demonstration, the merge of `main`
    (`5a98c74`), and open PR #3.
  - §2 Unit tests now lists all four files `test:unit` runs. It previously
    described only `quotation-scenarios.test.mts`.
  - §2 Build clarified, and §7 added to separate GitHub CI verification from the
    Vercel preview deployment.
  - §3 now notes `test:skills`.
- **2026-11-20 (later):** No decision changed.
  - Status updated: PR #3 was merged into `main` (`c8be4fe`), so the "not yet merged"
    bullet was replaced.
  - §2 Unit tests now lists a fifth file, `list-status.test.mts`, added with the
    review-status chips on *Your checks*.
