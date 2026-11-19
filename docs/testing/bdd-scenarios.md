# BDD scenarios for quotation verification (Week 5)

**Documented in Week 5 from the existing MVP requirements** — these two
Behaviour-Driven-Development scenarios were written now, during Week 5's
quality-assurance work, by reading the quotation-verification requirements already
in this repository (`docs/architecture.md` → TR-07/TR-08/TR-09, NFR-04) and the
wording-difference rule (`docs/adr/0006-wording-difference-detection.md`). They are
**not** a copy of Week 2 source documents — the Week 2 vision/scope/requirements
artifacts are referenced by `architecture.md` but are not stored in this repo (see
`docs/development-checklist.md`, item 3). Each scenario is backed by an automated
unit test that runs in CI on every push.

The scenarios target the **current checker**: server-side text comparison, **no
external AI** (see `architecture.md` → "Current implementation (MVP)").

---

## Scenario 1 — Incorrect participant credit (participant mismatch)

**Use case:** A researcher checks whether a report quotation is credited to the
correct participant.

**BDD:**
- **Given** the report credits a quotation to P03, but the exact quotation appears
  only in P05's transcript,
- **When** the researcher runs the quotation check,
- **Then** the app flags a **participant mismatch** and shows the original
  transcript passage, participant ID **P05**, and the source filename.

**Governing requirements:**
- **TR-08** — compare each quotation against participant-labeled speech across all
  transcripts, checking **wording and participant identity**.
- **TR-09 / NFR-04** — the shown excerpt is a real passage from the source
  (verbatim); nothing is invented.

**Relevant ADR-0006 matching rules:**
- An **exact** (verbatim, case/punctuation-normalized, contiguous) match takes
  priority across all participants, **preferring the credited participant** when one
  is named. Here the exact match is in **P05**, not the credited P03 → the result is
  a `participant_mismatch` whose evidence is **P05's** line.
- (Limitation noted in ADR-0006: an exact match in a non-credited participant
  outranks a near match in the credited one — not triggered here, since the fixture
  places the quote verbatim only in P05.)

**Automated test:** `scripts/ci/quotation-scenarios.test.mts`, Scenario 1 block
(run in CI by the **Unit tests (quotation scenarios)** job). Fixture: report
`P03 said, "the dashboard saved me time."`; transcripts P03 (nothing relevant) and
P05 (the exact line). It asserts the result is `has_issues`, matched to P05's
transcript, with a single `participant_mismatch` issue carrying P05's passage and
source document, and the credited id recorded as P03.

> Note on "source filename": the unit test pins the **source document** (its id and
> verbatim excerpt). The *filename* shown to the researcher is looked up from that
> document in the results view (`lib/reviews/issues-view.ts`), so it follows directly
> from the source document the test verifies.

---

## Scenario 2 — Quotation not found

**Use case:** A researcher checks whether a report quotation is supported by the
uploaded transcripts.

**BDD:**
- **Given** a report contains a quotation with no exact or sufficiently close wording
  match in any uploaded participant transcript,
- **When** the researcher runs the quotation check,
- **Then** the app flags **"Quote not found"** without inventing or displaying a
  supporting source passage.

**Governing requirements:**
- **TR-08** — comparison across all participant-labeled transcripts.
- **TR-09 / NFR-04** — a quote with no corresponding passage yields a **no-match**
  result; nothing is invented.

**Relevant ADR-0006 matching rules:**
- "**Sufficiently close**" is the near-match threshold: word-level similarity
  **≥ 0.70** on a quote of **≥ 4 words**. A passage at or above it would surface as a
  **"Possible wording difference"** (`wording_mismatch`) **with** a candidate passage.
- The fixture falls **below** that bar **and** has no exact match anywhere, so the
  outcome is `quote_not_found` with **no** source passage — distinct from a wording
  difference.

**Automated test:** `scripts/ci/quotation-scenarios.test.mts`, Scenario 2 block
(same CI job). Fixture: report
`The study notes, "a statement that is not present in any transcript at all."`;
transcript P03 with unrelated speech. It asserts the result is `has_issues` with a
single `quote_not_found` issue and **no** matched document, matched excerpt, source
document, or source excerpt.

---

## How the 10 automated assertions cover the two scenarios

The CI unit-test run reports **10 PASS lines** — 6 for Scenario 1, 4 for Scenario 2
— each mapping to a clause of its "Then":

**Scenario 1 (6):**
1. exactly one quotation is extracted from the report;
2. the credited participant is recorded as **P03** (the quote's listed id);
3. the result is flagged `has_issues`;
4. it matched the **actual speaker P05's** transcript (not P03's);
5. there is a **single `participant_mismatch`** issue;
6. the evidence is **P05's passage + source document** (`source_document_id` +
   verbatim `source_excerpt`).
Together 1–6 prove the "Then": a participant mismatch is flagged and the P05 passage,
participant, and source are shown.

**Scenario 2 (4):**
1. exactly one quotation is extracted;
2. the result is flagged `has_issues`;
3. the issue is **`quote_not_found`** (explicitly **not** a wording difference);
4. **no source passage** is shown — `matched_document_id` and `matched_excerpt` are
   null and the issue carries no `source_document_id`/`source_excerpt`.
Together 1–4 prove the "Then": "Quote not found" with nothing invented or displayed.

If the matching logic regresses (e.g., it misses the mismatch, attributes to the
wrong participant, invents a source for an unfound quote, or crosses the wording
threshold), the relevant assertion turns the **Unit tests** job red — which is the
intended "break-it-on-purpose" behaviour for the pipeline.

---

## Scenario 3 — Selecting an issue shows its labelled evidence (Results screen)

Unlike Scenarios 1–2 (which pin the **checker logic**), this is a
**presentation-layer** scenario for the Week 5 Results redesign: it pins what the
researcher sees when they **select** an already-flagged issue, on desktop and on a
phone. It is meant to be **verified manually** at desktop and phone widths, per
`docs/manual-browser-checklist.md` — it is not backed by a CI unit test.

**Verification status (2026-11-19):**
- **Desktop browser check:** not yet performed.
- **Mobile (phone-width) browser check:** not yet performed.
- **Done so far:** a code reading of `app/reviews/[id]/review-issues.tsx`
  (the desktop evidence panel and the mobile expanded card both render the
  selected issue's type label and explanation from the same issue entry), and a
  passing TypeScript check (`npx tsc --noEmit`). Neither is a substitute for the
  browser checks above.

**Use case:** On the Results review screen, a researcher selects a flagged issue to
read what kind of issue it is and why it was flagged.

**BDD:**
- **Given** a completed check whose results list at least two issues of different
  types — one **Possible wording difference** (`wording_mismatch`) and one
  **Participant mismatch** (`participant_mismatch`),
- **When** the researcher selects an issue,
- **Then (desktop)** the evidence panel beside the list **repeats the selected
  issue's type label** — the same "Possible wording difference" / "Participant
  mismatch" text shown in the list — **and** explains why it was flagged: for a
  wording difference, the report quote and the transcript excerpt with the differing
  words marked; for a participant mismatch, the credited-vs-found participant IDs —
  shown as an explanation visually separated from the source text,
- **And (mobile)** the expanded issue card shows **both** the type label and that
  same explanation inline, beneath the quote,
- **And** when the researcher switches the selection between the **Possible wording
  difference** and the **Participant mismatch**, the type label and the explanation
  update **together** to the newly selected issue — the panel never pairs one
  issue's label with another issue's evidence.

**Reference:** `docs/architecture.md` → "End-to-end walkthrough (one example)",
step 8 **"Show the evidence"** (report quote, transcript passage as verbatim escaped
text, both participant IDs, source filename, and an explanation visually separated
from the source text). This scenario adds the **issue-type label** alongside that
explanation and pins the desktop-panel vs. mobile-expanded-card presentations.

**Implemented by:** `app/reviews/[id]/review-issues.tsx` — the list/panel grid on
desktop and the expandable cards on mobile — with the type labels from
`lib/reviews/issues-view.ts` (`labelFor`: `wording_mismatch` → "Possible wording
difference", `participant_mismatch` → "Participant mismatch").
