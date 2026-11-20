// CI unit test for the statuses on the "Your checks" page.
//   - completed checks: Review in progress / Review complete / No issues found /
//     No quotations found / Review status unavailable
//   - unfinished checks keep their existing statuses
//   - counts match the review page's own counting (buildIssuesView)
//   - every row is read despite the API's per-request row limit
// Pure: reviewListStatus + countReviewProgress + fetchAllRows with in-memory
// data and a fake paged source. No DB, Storage, network, or env.

import {
  LIST_STATUS,
  countReviewProgress,
  fetchAllRows,
  reviewListStatus,
  type PageResult,
} from "../../lib/reviews/list-status";
import { buildIssuesView } from "../../lib/reviews/issues-view";

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) {
    console.log(`PASS: ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL: ${name} ${extra}`);
  }
}

// 1. Labels for completed checks.
{
  const s = (quotations: number, issues: number, decided: number) =>
    reviewListStatus("complete", { quotations, issues, decided });
  check("complete: 0 quotations -> No quotations found", s(0, 0, 0) === LIST_STATUS.noQuotations, s(0, 0, 0));
  check("complete: quotations, 0 issues -> No issues found", s(3, 0, 0) === LIST_STATUS.noIssues, s(3, 0, 0));
  check("complete: issues, none decided -> Review in progress", s(2, 3, 0) === LIST_STATUS.inProgress, s(2, 3, 0));
  check("complete: some decided -> Review in progress", s(2, 3, 2) === LIST_STATUS.inProgress, s(2, 3, 2));
  check("complete: all decided -> Review complete", s(2, 3, 3) === LIST_STATUS.complete, s(2, 3, 3));
  check("complete: counts unavailable -> Review status unavailable",
    reviewListStatus("complete", null) === LIST_STATUS.unavailable);
  check("No quotations found is distinct from No issues found", LIST_STATUS.noQuotations !== LIST_STATUS.noIssues);
  check("exact wording: Review in progress", LIST_STATUS.inProgress === "Review in progress");
  const all = [s(0, 0, 0), s(3, 0, 0), s(2, 3, 0), s(2, 3, 3), reviewListStatus("complete", null)];
  check("no completed label shows a count", all.every((label) => !/\d/.test(label)), JSON.stringify(all));
}

// 2. Unfinished checks keep their existing statuses, even if counts are passed.
{
  const counts = { quotations: 1, issues: 1, decided: 0 };
  check("draft -> Not checked yet", reviewListStatus("draft", null) === "Not checked yet");
  for (const status of ["uploading", "processing", "failed", "deleting"]) {
    check(`${status} -> unchanged`, reviewListStatus(status, counts) === status && reviewListStatus(status, null) === status);
  }
}

// 3. Counting matches the review page's rules, per review.
{
  const quotations = [
    { id: "q1", review_id: "rA", checking_result: "has_issues" },
    { id: "q2", review_id: "rA", checking_result: "no_issues" },
    { id: "q3", review_id: "rB", checking_result: "no_issues" },
    { id: "q9", review_id: "rOther", checking_result: "has_issues" }, // not requested
  ];
  const issues = [
    { id: "i1", review_id: "rA", quotation_id: "q1" },
    { id: "i2", review_id: "rA", quotation_id: "q1" }, // two issues on one quotation
    { id: "i3", review_id: "rA", quotation_id: "q2" }, // on a no_issues quotation: not counted
    { id: "i9", review_id: "rOther", quotation_id: "q9" },
  ];
  const decided = ["i1", "i9"];
  const counts = countReviewProgress({ reviewIds: ["rA", "rB", "rEmpty"], quotations, issues, decidedIssueIds: decided });

  const a = counts.get("rA");
  check("rA: 2 quotations, 2 issues, 1 decided",
    !!a && a.quotations === 2 && a.issues === 2 && a.decided === 1, JSON.stringify(a));
  check("rA -> Review in progress", reviewListStatus("complete", a ?? null) === LIST_STATUS.inProgress);
  const b = counts.get("rB");
  check("rB -> No issues found", reviewListStatus("complete", b ?? null) === LIST_STATUS.noIssues, JSON.stringify(b));
  const empty = counts.get("rEmpty");
  check("rEmpty is counted as zero, not missing", !!empty && empty.quotations === 0, JSON.stringify(empty));
  check("rEmpty -> No quotations found", reviewListStatus("complete", empty ?? null) === LIST_STATUS.noQuotations);
  check("rows for unrequested reviews are ignored", !counts.has("rOther"));

  // Cross-check with the review page's own counting for the same review.
  const view = buildIssuesView({
    quotations: [
      { id: "q1", original_text: "a quote", listed_participant_id: null, start_offset: 0, checking_result: "has_issues" },
      { id: "q2", original_text: "another quote", listed_participant_id: null, start_offset: 10, checking_result: "no_issues" },
    ],
    issues: [
      { id: "i1", quotation_id: "q1", issue_type: "quote_not_found", explanation: null, source_document_id: null, source_excerpt: null },
      { id: "i2", quotation_id: "q1", issue_type: "quote_not_found", explanation: null, source_document_id: null, source_excerpt: null },
      { id: "i3", quotation_id: "q2", issue_type: "quote_not_found", explanation: null, source_document_id: null, source_excerpt: null },
    ],
    documents: [],
    decisions: [{ issue_id: "i1", decision: "dismiss" }],
  });
  check("matches review page: quotations checked", !!a && a.quotations === view.quotationsChecked,
    `${a?.quotations} vs ${view.quotationsChecked}`);
  check("matches review page: total issues", !!a && a.issues === view.totalIssues, `${a?.issues} vs ${view.totalIssues}`);
  check("matches review page: reviewed count", !!a && a.decided === view.reviewedCount, `${a?.decided} vs ${view.reviewedCount}`);

  const allDecided = countReviewProgress({ reviewIds: ["rA"], quotations, issues, decidedIssueIds: ["i1", "i2"] });
  check("all issues decided -> Review complete",
    reviewListStatus("complete", allDecided.get("rA") ?? null) === LIST_STATUS.complete);
}

// 4. Reading every row despite the per-request row limit.
// A fake source with `total` rows that never returns more than `cap` per request.
function pagedSource(total: number, cap: number, opts: { countOverride?: number | null; failOnCall?: number } = {}) {
  const rows = Array.from({ length: total }, (_, i) => ({ n: i }));
  let calls = 0;
  const fetchPage = async (from: number, to: number): Promise<PageResult<{ n: number }>> => {
    calls += 1;
    if (opts.failOnCall === calls) return { data: null, error: new Error("boom"), count: null };
    const end = Math.min(to + 1, from + cap, total);
    const count = opts.countOverride === undefined ? total : opts.countOverride;
    return { data: rows.slice(from, end), error: null, count };
  };
  return { fetchPage, calls: () => calls };
}
{
  const capped = pagedSource(2500, 1000);
  const r1 = await fetchAllRows(capped.fetchPage, 1000);
  check("2500 rows, cap 1000: all rows read", r1?.length === 2500, String(r1?.length));
  check("2500 rows, cap 1000: rows in order, none repeated", !!r1 && r1.every((row, i) => row.n === i));
  check("2500 rows, cap 1000: 3 requests", capped.calls() === 3, String(capped.calls()));

  const smallCap = pagedSource(2500, 300);
  const r2 = await fetchAllRows(smallCap.fetchPage, 1000);
  check("server cap smaller than page size: still reads all rows", r2?.length === 2500, String(r2?.length));

  const exact = pagedSource(1000, 1000);
  const r3 = await fetchAllRows(exact.fetchPage, 1000);
  check("exactly one full page: 1000 rows, 1 request", r3?.length === 1000 && exact.calls() === 1, `${r3?.length} / ${exact.calls()}`);

  const none = pagedSource(0, 1000);
  const r4 = await fetchAllRows(none.fetchPage, 1000);
  check("no rows: empty list (not unavailable)", Array.isArray(r4) && r4.length === 0);

  const failing = pagedSource(2500, 1000, { failOnCall: 2 });
  check("error on a later page -> null (unavailable)", (await fetchAllRows(failing.fetchPage, 1000)) === null);

  const noCount = pagedSource(10, 1000, { countOverride: null });
  check("total not reported -> null (unavailable)", (await fetchAllRows(noCount.fetchPage, 1000)) === null);

  const grewTooFew = pagedSource(10, 1000, { countOverride: 12 });
  check("server reports more rows than it can send -> null (unavailable)",
    (await fetchAllRows(grewTooFew.fetchPage, 1000)) === null);

  const shrank = pagedSource(10, 1000, { countOverride: 8 });
  check("more rows received than the total -> null (unavailable)", (await fetchAllRows(shrank.fetchPage, 1000)) === null);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nALL LIST-STATUS CHECKS PASSED");
