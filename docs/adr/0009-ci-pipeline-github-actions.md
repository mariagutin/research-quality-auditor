# ADR-0009: CI pipeline on GitHub Actions (four checks)

## Date and status
2026-11-14. Accepted (implemented locally on branch `week-5-cicd`; **not committed,
pushed, or deployed** yet).

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
- **Unit tests — `npm run test:unit` (`tsx scripts/ci/quotation-scenarios.test.mts`).**
  Verifies the two BDD scenarios against the **pure** `analyzeReport`:
  *participant mismatch* (quote credited to P03 but verbatim only in P05 → a single
  `participant_mismatch` with P05's passage + source document) and *quote not found*
  (no exact and no ≥0.70/≥4-word match → `quote_not_found`, **no** source passage,
  nothing invented). Fails if the matching logic regresses. **This is the
  break-it-on-purpose target.**
- **Build — `npm run build` (`next build`).** A **production-compilation** check —
  the same compile Vercel runs on deploy (routes build, server/client boundaries
  valid, imports resolve). It **also lints and type-checks** (Next's default), so it
  fails on a production build error, a type error, **or** a lint error — overlapping
  the Lint/Typecheck jobs on purpose (defense-in-depth): the dedicated jobs give
  fast, clearly-labeled feedback, and the build proves those same checks hold in the
  real production compile.

### 3. Tooling added (pinned to the installed Next 15.5.29)
- `eslint ^8.57.1` + `eslint-config-next@15.5.29` (same version as the installed
  Next) + `.eslintrc.json` → `{ "extends": "next/core-web-vitals" }`.
- `tsx ^4.20.0` as a **devDependency** (so CI runs the unit tests from
  `node_modules` via `npm ci`, not an on-the-fly `npx` fetch).
- `package.json` scripts: `typecheck`, `test:unit`.
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
