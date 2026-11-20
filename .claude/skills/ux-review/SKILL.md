---
name: ux-review
description: Reviews user interfaces for usability problems using Nielsen's 10 usability heuristics. Use when reviewing UI screenshots, mockups, or front-end application code for usability issues, UX problems, or heuristic evaluation.
---

# UX Review

Evaluate a user interface against Nielsen's 10 usability heuristics and produce
a prioritized, actionable findings report. Works from screenshots, mockups, or
front-end code (or a combination).

## Scope

This skill performs **UX heuristic evaluation**. It may *flag* potential
accessibility concerns it happens to notice (e.g. a missing label), but detailed
WCAG conformance checking is out of scope — route that to a separate
`accessibility-audit` skill. Keep findings here framed as usability issues.

## Inputs

Accept any of:
- **Screenshots / mockups** — evaluate the visible, rendered experience.
- **Front-end code** — HTML/JSX/templates, CSS, and component logic.
- **A flow** — several screens or a described user journey.

If the user gives code but no screenshot (or vice versa), review what you have
and mark any check you cannot confirm as **Not verifiable** (see below).

## Workflow

Copy this checklist and work through it in order:

```
UX Review Progress:
- [ ] 1. Clarify scope: which screen/flow, and the user's primary goal
- [ ] 2. Inventory the inputs (screenshots, code, flow)
- [ ] 3. Evaluate and classify all 10 heuristics
- [ ] 4. Assign a severity (0-4) to each Issue found
- [ ] 5. Write the findings report
```

**Step 1 — Clarify scope.** Identify the screen or flow under review and the
primary task the user is trying to accomplish. Usability is judged relative to
a goal, so state it explicitly.

**Step 2 — Inventory inputs.** Note what you have (screenshot, code, or both)
and what that lets you assess.

**Step 3 — Evaluate and classify all 10 heuristics.** Go through every heuristic
using the detailed criteria in
[references/usability-heuristics.md](references/usability-heuristics.md).
Give **each** heuristic exactly one status:

- **Issue found** — there is concrete evidence of a usability problem.
- **No issue observed** — there is positive evidence the heuristic is handled
  well. Do NOT use this status merely because you saw no problem; absence of
  evidence is not evidence of compliance.
- **Not verifiable** — the available inputs are insufficient to judge. State
  what additional input would be needed (e.g. "need the error state" or
  "need the submit handler code").

**Evidence check (before marking "Issue found").** Confirm you observed the
actual evidence — not merely its absence from static markup. If a judgment
depends on code or styling you were not given (for example an event handler
like `saveProfile()`, or the CSS that determines a button's visual weight),
the honest status is **Not verifiable**, not **Issue found**.

**Step 4 — Rate severity.** For each **Issue found**, assign a 0-4 rating (scale
below). Mark the rating **(provisional)** whenever you cannot confirm how often
it occurs or its real impact on users — which is typical when reviewing a static
screenshot or code in isolation.

**Step 5 — Write the report** using the structure below.

## Severity scale

Based on NNG's severity ratings (combine frequency, impact, and persistence):

| Rating | Meaning |
|--------|---------|
| 0 | Not a usability problem |
| 1 | Cosmetic — fix only if time allows |
| 2 | Minor — low priority |
| 3 | Major — important to fix, high priority |
| 4 | Catastrophe — imperative to fix before release |

**Provisional ratings:** A full severity rating needs frequency, impact, and
persistence. From a single screenshot or code snippet, frequency and real user
impact are often unknown — estimate from impact/persistence and append
`(provisional)`, noting what evidence (analytics, user testing, the full flow)
would confirm it.

## Report structure

```markdown
# UX Review: [screen/flow name]

**Scope:** [what was reviewed] · **User goal:** [primary task]
**Inputs reviewed:** [screenshot / code / both]

## Status at a glance
| # | Heuristic | Status | Severity |
|---|-----------|--------|----------|
| 1 | Visibility of System Status | Issue found / No issue observed / Not verifiable | [0-4, provisional?] |
| ... | ... | ... | ... |

## Summary
[2-3 sentences: overall state and the most important issues]

## Issues found
For each Issue found:
### [Severity N] [Short title] — Heuristic #[n]: [heuristic name]
- **Problem:** what's wrong and where (cite the element, or file:line for code)
- **Evidence:** what you observed that supports this
- **Why it matters:** the user impact
- **Recommendation:** a concrete, actionable fix

## No issue observed
[Heuristics with positive evidence of good handling — note the evidence briefly]

## Not verifiable
[Heuristics you couldn't assess — and the specific input needed to assess each]

## Potential accessibility concerns (out of scope — for accessibility-audit)
[Anything accessibility-related you noticed in passing, flagged but not assessed]
```

## Principles

- Be specific: cite the exact element, label, or `file:line`, never "the page".
- Classify honestly: never mark "No issue observed" without positive evidence.
- Every Issue found needs an actionable recommendation, not just a complaint.
- Judge against the user's goal, not personal taste.

## Reference files

- [references/usability-heuristics.md](references/usability-heuristics.md) —
  the 10 heuristics with definitions, screenshot cues, code cues, common
  violations, and evidence guidance. Read it during Step 3.
