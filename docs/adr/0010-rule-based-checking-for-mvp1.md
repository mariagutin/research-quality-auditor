# ADR-0010: Rule-based checking for MVP #1 (AI deferred to a later release)

## Date and status
2026-11-15. Accepted.

> Resolves the long-standing **"AI provider / AI-assisted checking" open decision**
> that `docs/architecture.md` had carried since the start (the "Evidence verification"
> bullet and Open Decision #1). This ADR settles it **for MVP #1**: the quotation and
> participant checks are **rule-based text comparison, with no external AI**. It
> consolidates and makes final the direction ADR-0006 took provisionally
> ("AI-assisted comparison remains a later upgrade").

## Context
The product verifies that quotations in a research report match the uploaded interview
transcripts and are attributed to the right participant. From the first design,
`architecture.md` described the checker as **AI-assisted** (an AI provider extracts
quotations and proposes candidate passages; server code then verifies each excerpt is
real). Which AI provider/model to use was logged as **Open Decision #1** and described
as blocking the extraction and comparison features.

In practice, the checker was built and shipped as **deterministic, server-side text
comparison** with no external AI:
- Extraction = straight double-quoted spans from the report.
- Matching = exact (verbatim, case/punctuation-insensitive) first, then a lexical
  near-match (word-level LCS, fitting-alignment window) with a provisional 0.70
  threshold and a four-word floor — see **ADR-0006**.
- Every excerpt shown is a **verbatim** transcript passage; nothing is invented.

This has been verified end to end locally and on hosted (Week 4), and the app's
data-handling notice tells users their files **"are not sent to any external AI
service."** The only remaining ambiguity was documentary: `architecture.md` still
framed AI as unresolved and as a dependency of MVP #1.

## Decision
**MVP #1's quotation and participant checks are implemented with rule-based text
comparison, and use no external AI.** This is the final decision for MVP #1, not a
temporary state:

1. The quotation/participant checker is the deterministic matcher described in
   **ADR-0006** (and its 2026-11-15 full-turn/fitting-alignment update). No AI
   provider, API key, or external model is part of MVP #1.
2. **Open Decision #1 (AI provider and model) no longer blocks MVP #1.** It is
   reclassified as a **post-MVP-#1** evaluation item, not a gap in the current scope.
3. **AI is deferred — to be evaluated for a later release, not committed to.** A
   future release *may* look beyond "was this quote said and correctly attributed" to
   broader research claims (potentially across the four quality dimensions). Whether to
   use AI there — and which provider/model — is an **open evaluation**, not a decision
   this ADR makes. If AI is adopted, its data-handling/retention/training-use policy
   must be reviewed and the provider named in the data-handling notice **before any
   confidential material is processed** (NFR-03), captured in that release's own ADR.

## Consequences
- **Scope is settled.** MVP #1 is complete on its own terms: a working, private,
  per-account app whose checker is rule-based and fully testable without secrets or
  network calls. "Fully functioning MVP #1" no longer waits on an AI decision.
- **Accepted limitations carry forward** (already recorded, not regressions): the
  wording check is **lexical, not semantic**; extraction is limited to **straight
  double-quoted** spans (curly/smart quotes and paraphrases outside quotes are not
  caught, and quoted non-quotation text such as a product name can be over-extracted —
  see `docs/testing/known-limitations.md` QE-1); and TR-07's "Participant not
  specified" flag is not fully implemented. These are the natural candidates a future
  release could improve — where AI is one option **to be evaluated**, not a settled
  approach.
- **Privacy posture simplified.** With no external AI in MVP #1, there is no
  third-party data-processing surface to disclose or review for this release; the
  data-handling notice's "no external AI service" statement is accurate.
- **No code or schema change.** This ADR records a decision already reflected in the
  shipped implementation; it only updates the documentation framing in
  `architecture.md`. Hosted Supabase is untouched.

## Verification
- The rule-based checker's behavior is covered by the existing suites referenced in
  ADR-0006 (`scripts/ci/turn-matching.test.mts`, `scripts/run-check.local-test.mts`,
  `scripts/text-compare.local-test.mts`, `scripts/issues-view.local-test.mts`) and the
  Week 4 hosted verification (`docs/testing/hosted-verification.md`).
- No external/AI calls exist in `lib/reviews/run-check.ts` or
  `lib/reviews/text-compare.ts` (only Supabase storage/DB are contacted), consistent
  with this decision.
