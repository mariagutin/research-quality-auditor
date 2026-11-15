// CI unit test for the three results states on the review page:
//   - no_quotations : the report had no quotations to check (TR-18)
//   - no_issues     : quotations were checked and all matched (TR-17)
//   - has_issues    : at least one issue to review
// Pure: buildIssuesView + resultState, in-memory, no DB/Storage/network.
// Guards the exact discriminator the page uses to pick the empty-state message.

import { buildIssuesView, resultState } from "../../lib/reviews/issues-view";

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) {
    console.log(`PASS: ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL: ${name} ${extra}`);
  }
}

const documents = [{ id: "t-p05", filename: "p05.md", participantId: "P05" }];

// 1. No quotations found (report had nothing in double quotes).
{
  const view = buildIssuesView({ quotations: [], issues: [], documents });
  check("no_quotations: quotationsChecked is 0", view.quotationsChecked === 0, JSON.stringify(view));
  check("no_quotations: no entries", view.entries.length === 0);
  check("no_quotations: resultState === 'no_quotations'", resultState(view) === "no_quotations", resultState(view));
}

// 2. Quotations checked, none flagged.
{
  const view = buildIssuesView({
    quotations: [
      { id: "q1", original_text: "the dashboard saved me time.", listed_participant_id: "P05", start_offset: 0, checking_result: "no_issues" },
    ],
    issues: [],
    documents,
  });
  check("no_issues: quotationsChecked is 1", view.quotationsChecked === 1, JSON.stringify(view));
  check("no_issues: no entries", view.entries.length === 0);
  check("no_issues: resultState === 'no_issues'", resultState(view) === "no_issues", resultState(view));
}

// 3. Quotations checked, at least one issue.
{
  const view = buildIssuesView({
    quotations: [
      { id: "q1", original_text: "a quote not in any transcript.", listed_participant_id: null, start_offset: 0, checking_result: "has_issues" },
    ],
    issues: [
      { id: "i1", quotation_id: "q1", issue_type: "quote_not_found", explanation: "Quote not found.", source_document_id: null, source_excerpt: null },
    ],
    documents,
  });
  check("has_issues: one entry", view.entries.length === 1, JSON.stringify(view));
  check("has_issues: resultState === 'has_issues'", resultState(view) === "has_issues", resultState(view));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nALL RESULT-STATE CHECKS PASSED");
