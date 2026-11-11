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
  { id: "doc-p03", filename: "p03.md" },
  { id: "doc-p05", filename: "p05.md" },
];

// Three quotations in the report, out of start_offset order on purpose:
//   q-mismatch  -> has_issues, participant_mismatch, evidence in p05.md
//   q-ok        -> no_issues  (must NOT appear)
//   q-missing   -> has_issues, quote_not_found, no evidence
const quotations: QuotationRow[] = [
  {
    id: "q-missing",
    original_text: "a line nobody actually said",
    listed_participant_id: null,
    start_offset: 300,
    checking_result: "has_issues",
  },
  {
    id: "q-ok",
    original_text: "it was simple to set up",
    listed_participant_id: null,
    start_offset: 100,
    checking_result: "no_issues",
  },
  {
    id: "q-mismatch",
    original_text: "the dashboard saved me time",
    listed_participant_id: "P03",
    start_offset: 50,
    checking_result: "has_issues",
  },
];

const issues: IssueRow[] = [
  {
    quotation_id: "q-mismatch",
    issue_type: "participant_mismatch",
    explanation: "Report attributes this quote to P03, but it was said by P05.",
    source_document_id: "doc-p05",
    source_excerpt: "P05: the dashboard saved me time.",
  },
  {
    quotation_id: "q-missing",
    issue_type: "quote_not_found",
    explanation: "Quote not found in any participant's transcript.",
    source_document_id: null,
    source_excerpt: null,
  },
];

const view = buildIssuesView({ quotations, issues, documents });

// Summary counts all three quotations, two with issues.
assert.equal(view.totalChecked, 3, "totalChecked");
assert.equal(view.totalWithIssues, 2, "totalWithIssues");

// Only the two problem quotations appear, in report order (offset 50 then 300).
assert.equal(view.items.length, 2, "item count");
assert.equal(view.items[0].quotationId, "q-mismatch", "first by offset");
assert.equal(view.items[1].quotationId, "q-missing", "second by offset");

// The no_issues quote is absent.
assert.ok(
  !view.items.some((i) => i.quotationId === "q-ok"),
  "no_issues quote must be hidden",
);

// Participant mismatch: report credit + evidence filename/line.
const mismatch = view.items[0];
assert.equal(mismatch.quote, "the dashboard saved me time");
assert.equal(mismatch.reportCredits, "P03");
assert.equal(mismatch.issues.length, 1);
assert.equal(mismatch.issues[0].label, "Participant mismatch");
assert.deepEqual(mismatch.issues[0].evidence, {
  filename: "p05.md",
  excerpt: "P05: the dashboard saved me time.",
});

// Quote not found: no report credit, no evidence.
const missing = view.items[1];
assert.equal(missing.reportCredits, null);
assert.equal(missing.issues[0].label, "Quote not found");
assert.equal(missing.issues[0].evidence, null);

console.log("issues-view: all assertions passed");
