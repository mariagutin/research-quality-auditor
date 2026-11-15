# Known limitations (found in testing)

Limitations observed during testing and **intentionally left unfixed for now**, with
the reasoning. Recorded so they are not re-discovered as surprises and so any future
change is a deliberate decision, not a silent one.

---

## QE-1 — Quoted non-quotation text is extracted as a participant quotation

**Found:** HW #4 manual browser test, 2026-11-15 (local), using the synthetic
`~/Desktop/rqa-sample/` files.

**What happened.** The report title contained a product name in double quotes —
`"Nimbus"`. The checker extracts **any straight double-quoted span** as a quotation,
so `Nimbus` was treated as a participant quotation. It is in no transcript, so it was
flagged **"Quote not found."** This inflated the counts to **6 quotations checked /
4 issues**, versus the expected **5 quotations / 3 issues** for that sample.

**Human-review path worked.** Selecting **Dismiss** on the false issue behaved
correctly, and review progress updated to **"1 of 4 issues reviewed."** So the
decision/progress flow handles a false alert gracefully; the limitation is in
extraction, not in review.

**Root cause.** Extraction is "straight double-quoted spans" (`lib/reviews/run-check.ts`;
see `docs/adr/0006-wording-difference-detection.md` and the "Current implementation
(MVP)" note in `docs/architecture.md`). A double-quoted span can be many things other
than a participant quotation — a product or proper name, a title, scare quotes, or
emphasis — and the extractor cannot currently tell them apart.

**Decision — not changing extraction rules yet, and NOT excluding one-word
quotations.** A short or even one-word quoted span can be a **valid** participant
quotation, so filtering by length (e.g. dropping one-word quotes) would cause **false
negatives** — missing real quotations — which is worse than an occasional false
"Quote not found" that the researcher can simply **Dismiss**. For MVP we accept the
false-positive and rely on the human-review path. Any fix here is a deliberate future
decision, recorded via a new ADR when taken.

**Possible future directions (not decided, not scheduled):** require nearby
attribution context before treating a span as a quotation; ignore quoted spans inside
headings/titles; let the researcher mark a flagged item as "not a quotation." None are
chosen yet.

**Testing note.** When counting expected quotations for a sample, remember that *any*
double-quoted text in the report (including in titles) is currently extracted. The
synthetic samples are for testing only and contain no real research data.
