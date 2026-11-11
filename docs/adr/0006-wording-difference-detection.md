# ADR-0006: Wording-difference detection (deterministic near-matching)

## Date and status
2026-11-11. Accepted.

> Builds on the quotation check established across commits `02a58fa`,
> `47fed19`, and `0d8c876`. Those matched a report quote **verbatim** against
> participant-labeled speech and flagged participant attribution. This ADR adds
> detection of **reworded** quotations — the "wording mismatch" issue that
> `docs/architecture.md` (TR-08) always called for — and records the rules,
> settings, and limitations.

## Context
A report may quote a participant with slightly different words than the
transcript ("saved me time" vs. "saved me a lot of time"). Verbatim-only
matching misses these entirely — they fall through to "quote not found." We want
to surface a **possible source passage** for review, including when it sits in a
different participant's transcript (a combined participant + wording problem).

`architecture.md` envisions AI-assisted candidate-passage finding. We chose a
**deterministic** heuristic instead, for now: no API key, cost, or
non-determinism, fully testable against the local stack, and consistent with the
rest of the checker. AI-assisted comparison remains a later upgrade. In all
cases the stored evidence is a **verbatim** transcript passage (NFR-04).

## Decision

### 1. How two passages are compared (pure, `lib/reviews/text-compare.ts`)
Words are normalized (lowercased, outer punctuation stripped), so casing and
surrounding punctuation are **not** wording differences. Overlap "in order" is
measured with a word-level Longest Common Subsequence (LCS):

- **similarity = 2 × LCS ÷ (wordsA + wordsB)** — 1.0 when identical; lower as
  words are inserted, removed, substituted, or reordered.
- An **exact** match means the quote's words appear as a **contiguous run**
  inside the passage (verbatim up to case/punctuation).

### 2. Selection precedence (`analyzeReport`)
For each quotation, with the report's credited participant (if any):

1. **Exact matches take priority across all participants.** Prefer the credited
   participant; otherwise the first exact passage by the tie-breaker below.
   - In the credited participant (or none credited) → **no issue**.
   - Only in another participant → **participant mismatch** (worded plainly:
     "…but it was said by P05" — justified, because the wording is exact).
2. **Only if no exact match exists anywhere**, look for a near match, and
   **only for quotes of ≥ 4 words**:
   - Prefer the credited participant's **highest-scoring** qualifying passage.
   - Else the highest-scoring from **other** participants.
   - Else, if no participant is credited, the highest-scoring **overall**.
   - Outcomes: credited/none → **possible wording difference**; another
     participant → **participant mismatch + possible wording difference**.
3. Otherwise → **quote not found**.

### 3. Settings (provisional, under local evaluation)
- **Near-match threshold = 0.70.**
- **Minimum quote length for near-matching = 4 words.** Shorter quotes are
  exact-only (one word swings a short ratio too far).

These two are provisional and are being evaluated through local testing; they
live as named constants in `lib/reviews/run-check.ts`.

### 4. Tie-breaker (stable, documented)
Passages are ordered by **participant id, then document id, then line position**.
Equal-scoring near candidates resolve to the earliest in that order; the first
exact passage is chosen in that order too. The order is independent of database
row order, so results are deterministic.

### 5. Cautious wording for a cross-participant near match
When a near match comes from a participant other than the one credited, both
labels are kept, but the attribution is worded cautiously — "The report credits
P03; a possible source passage was found in P05's transcript" — never claiming
similarity proves who spoke the quotation. Similarity identifies a **possible
source**, not equivalent meaning.

### 6. Display (`issues-view.ts`, `app/reviews/[id]/page.tsx`)
Results show **one entry per issue** (not multiple labels on one quotation), so
that each issue can later carry its own review decision. A quotation with two
issues produces two entries placed together, each tagged "Issue N of M for this
quotation"; entries are in report order. Each entry is self-contained: the
quotation, one label, its explanation, and the evidence relevant to that issue —
a **participant mismatch** shows the verbatim source passage (filename +
participant id); a **wording difference**, labeled "Possible wording
difference," shows the report quote and the verbatim transcript passage with the
differing words highlighted on each side; **quote not found** shows none. The
summary counts two things separately: quotations checked and issues found
("Checked 1 quotation · 2 issues found"). Moderator speech is excluded throughout
(only participant-labeled lines are compared), as before. No review-decision
controls are shown yet.

## Consequences / limitations
- **Similarity is not meaning.** A near match points to a *possible* source; it
  can pair a quote with a similar-but-unrelated line (e.g. "it saved me time" vs.
  "it saved me money", ~0.75 → surfaced for review), or flag a harmless
  paraphrase. A negation ("was reliable" vs. "was not reliable", ~0.89) is
  surfaced precisely because one word can flip meaning. The researcher judges —
  hence the "possible" framing.
- **Exact-match limitation (explicitly accepted).** An exact match in P05 takes
  priority over a near match in the credited P03, so the **selected passage may
  not be the intended source.** This follows directly from "exact matches take
  priority across all participants."
- **Line-bounded.** Comparison is per speaker turn; a quote spanning two turns or
  split across lines will not match (same limit as verbatim matching).
- **Short quotes (< 4 words)** are exact-only, so a reworded short quote is not
  flagged.
- **Order-sensitive; no synonyms/stemming.** Heavily reordered wording scores
  lower and may be missed; "set up" vs. "setup" counts as a difference.
- **One source shown per quotation** — the single best passage, not all
  candidates.

## Verification
- Pure helpers: `scripts/text-compare.local-test.mts` (normalization, similarity,
  contiguous match, highlight segments).
- Matching: `scripts/run-check.local-test.mts` adds cases for reworded
  same-participant (Q), combined participant + wording (R), negation (S), short
  quote (T), high-overlap different meaning (U1/U2), competing candidates (V),
  and the exact-match limitation (W), plus the existing verbatim and integration
  cases.
- View model: `scripts/issues-view.local-test.mts` covers the diff and plain
  evidence shapes and the combined two-label item.
- No schema change: the `wording_mismatch` issue type and multiple issues per
  quotation were already supported, so no migration. Hosted Supabase is
  untouched.
