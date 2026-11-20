# Vendored Claude Agent Skills

These three skills are **verbatim copies** vendored into this repository so the CI
pipeline can validate them here (Morgan confirmed the Week 1 skills should become CI
checks in this app repo). **Do not edit the copies to change skill behavior** — edit
the upstream repository and re-vendor. The copies exist to be structurally validated
and version-pinned, not forked.

## Source

| | |
|---|---|
| Source repository | `mariagutin/AI-Development-Residency` (github.com/mariagutin/AI-Development-Residency) |
| Source path | `.claude/skills/` |
| Source commit | `ac98a7bb4f0f336dfc6977f7cd93d4ed7170a298` (2026-10-21) |
| Vendored on | 2026-11-16 |

The copies are byte-identical to the source — each file's Git blob SHA equals the
blob SHA in the source repository at the commit above:

| File | Git blob SHA |
|---|---|
| `accessibility-audit/SKILL.md` | `233d20ab2b43…` |
| `accessibility-audit/references/wcag-checklist.md` | `b918f5c61e56…` |
| `research-interview-coach/SKILL.md` | `d2d927a5b60a…` |
| `ux-review/SKILL.md` | `fe7103197fee…` |
| `ux-review/references/usability-heuristics.md` | `5d43af03eadb…` |

To re-verify a copy against the source:

```sh
git hash-object .claude/skills/<path>
gh api repos/mariagutin/AI-Development-Residency/contents/.claude/skills/<path> --jq '.sha'
```

## What validates them

`scripts/ci/skill-structure.test.mts` (run by the **Skill checks** CI job, and
locally via `npm run test:skills`).

**Scope — important:** these checks validate the skill **files** — their structure,
required `name`/`description` metadata and documented field limits, and
reference-link integrity — **not** the audits, UX reviews, or interview coaching the
skills produce, and not their quality or effectiveness. Judging a skill's actual
*output* would require AI-based evaluation, which is a separate, optional concern and
is out of scope here. See `docs/adr/0009-ci-pipeline-github-actions.md` for the
decision and the exact rule sources, and `docs/adr/0010-rule-based-checking-for-mvp1.md`
for why this file-level, deterministic validation is consistent with the app's own
rule-based approach.
