// Pure test for buildIssuesView. No database: synthetic rows in, view model out.
// Run with:  npx tsx scripts/issues-view.local-test.mts

import assert from "node:assert/strict";
import {
  buildIssuesView,
  type QuotationRow,
  type IssueRow,
  type DocumentRow,
} from "../lib/reviews/issues-view.ts";

const documents: DocumentRow[] = [
  { id: "doc-report", filename: "report.md" },
  { id: "doc-p03", filename: "p03.md", participantId: "P03" },
  { id: "doc-p05", filename: "p05.md", participantId: "P05" },
];

// Five quotations (out of report order on purpose):
//   q-combined -> participant_mismatch + wording_mismatch (diff evidence)
//   q-mismatch -> participant_mismatch only (plain verbatim evidence)
//   q-ok       -> no_issues (must NOT appear)
//   q-wording  -> wording_mismatch only (diff evidence)
//   q-missing  -> quote_not_found (no evidence)
const quotations: QuotationRow[] = [
  { id: "q-missing", original_text: "nobody said this at all", listed_participant_id: null, start_offset: 120, checking_result: "has_issues" },
  { id: "q-ok", original_text: "verbatim and verified", listed_participant_id: null, start_offset: 70, checking_result: "no_issues" },
  { id: "q-wording", original_text: "it saved me time", listed_participant_id: null, start_offset: 90, checking_result: "has_issues" },
  { id: "q-mismatch", original_text: "exact words here", listed_participant_id: "P03", start_offset: 50, checking_result: "has_issues" },
  { id: "q-combined", original_text: "the dashboard saved me time", listed_participant_id: "P03", start_offset: 10, checking_result: "has_issues" },
];

const issues: IssueRow[] = [
  { id: "i-cb-pm", quotation_id: "q-combined", issue_type: "participant_mismatch", explanation: "The report credits P03; a possible source passage was found in P05's transcript.", source_document_id: "doc-p05", source_excerpt: "P05: the dashboard saved me a lot of time." },
  { id: "i-cb-wd", quotation_id: "q-combined", issue_type: "wording_mismatch", explanation: "This quote is not word-for-word; the closest passage is shown as a possible source to review.", source_document_id: "doc-p05", source_excerpt: "P05: the dashboard saved me a lot of time." },
  { id: "i-mm", quotation_id: "q-mismatch", issue_type: "participant_mismatch", explanation: "Report attributes this quote to P03, but it was said by P05.", source_document_id: "doc-p05", source_excerpt: "P05: exact words here." },
  { id: "i-wd", quotation_id: "q-wording", issue_type: "wording_mismatch", explanation: "This quote is not word-for-word in P05's transcript; the closest passage is shown as a possible source to review.", source_document_id: "doc-p05", source_excerpt: "P05: it saved me money." },
  { id: "i-missing", quotation_id: "q-missing", issue_type: "quote_not_found", explanation: "Quote not found in any participant's transcript.", source_document_id: null, source_excerpt: null },
];

// Two of the five issues have a saved decision.
const decisions = [
  { issue_id: "i-cb-pm", decision: "needs_correction" as const },
  { issue_id: "i-wd", decision: "dismiss" as const },
];

const view = buildIssuesView({ quotations, issues, documents, decisions });

// Summary: five quotations checked, each issue counted separately (2+1+1+1 = 5),
// two of them reviewed.
assert.equal(view.quotationsChecked, 5, "quotationsChecked");
assert.equal(view.totalIssues, 5, "totalIssues");
assert.equal(view.reviewedCount, 2, "reviewedCount");

// Each entry carries its own issue id and decision.
assert.deepEqual(
  view.entries.map((e) => [e.issueId, e.decision]),
  [
    ["i-cb-pm", "needs_correction"],
    ["i-cb-wd", null],
    ["i-mm", null],
    ["i-wd", "dismiss"],
    ["i-missing", null],
  ],
  "per-entry issue id + decision",
);

// One entry per issue, in report order (10, 10, 50, 90, 120), same-quotation
// entries together; the no_issues quote is absent.
assert.deepEqual(
  view.entries.map((e) => e.quotationId),
  ["q-combined", "q-combined", "q-mismatch", "q-wording", "q-missing"],
  "entry order + grouping + exclusion",
);
assert.deepEqual(
  view.entries.map((e) => e.label.label),
  ["Participant mismatch", "Possible wording difference", "Participant mismatch", "Possible wording difference", "Quote not found"],
  "per-entry labels",
);

// q-combined: two entries, tagged 1 of 2 / 2 of 2.
const [cbMismatch, cbWording] = view.entries;
assert.equal(cbMismatch.issueCount, 2, "combined issueCount");
assert.equal(cbMismatch.issueIndex, 1, "combined first index");
assert.equal(cbWording.issueIndex, 2, "combined second index");
assert.equal(cbMismatch.reportCredits, "P03");
// The participant-mismatch entry shows the plain verbatim passage...
assert.ok(cbMismatch.evidence?.kind === "plain", "combined mismatch -> plain evidence");
if (cbMismatch.evidence?.kind === "plain") {
  assert.equal(cbMismatch.evidence.excerpt, "P05: the dashboard saved me a lot of time.");
  assert.equal(cbMismatch.evidence.filename, "p05.md");
}
// ...the wording entry shows the highlighted diff.
assert.ok(cbWording.evidence?.kind === "diff", "combined wording -> diff evidence");
if (cbWording.evidence?.kind === "diff") {
  assert.equal(cbWording.evidence.participantId, "P05");
  assert.deepEqual(cbWording.evidence.transcript.filter((s) => s.changed).map((s) => s.text), ["a", "lot", "of"], "wording highlights inserted words");
}

// q-mismatch: single issue -> issueCount 1, plain evidence.
const mismatch = view.entries[2];
assert.equal(mismatch.issueCount, 1, "mismatch issueCount");
assert.ok(mismatch.evidence?.kind === "plain" && mismatch.evidence.excerpt === "P05: exact words here.");

// q-wording: single issue -> diff highlighting the substituted word each side.
const wording = view.entries[3];
assert.equal(wording.issueCount, 1, "wording issueCount");
assert.ok(wording.evidence?.kind === "diff", "wording -> diff evidence");
if (wording.evidence?.kind === "diff") {
  assert.deepEqual(wording.evidence.report.filter((s) => s.changed).map((s) => s.text), ["time"], "report highlights 'time'");
  assert.deepEqual(wording.evidence.transcript.filter((s) => s.changed).map((s) => s.text), ["money."], "transcript highlights 'money.'");
}

// q-missing: single issue, no evidence.
const missing = view.entries[4];
assert.equal(missing.issueCount, 1, "missing issueCount");
assert.equal(missing.label.label, "Quote not found");
assert.equal(missing.evidence, null, "quote-not-found has no evidence");

console.log("issues-view: all assertions passed");
