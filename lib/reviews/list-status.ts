// The status shown for each check on the "Your checks" page.
//
// Pure (rows and counts in, labels out) so it is directly testable without a
// database. For a COMPLETED check the label reflects the researcher's review
// progress, using the same rules as the review page:
//   - quotations and issues are counted as `buildIssuesView` counts them
//     (issues only on quotations marked `has_issues`), and
//   - any saved decision counts as reviewed (ADR-0007).
// No counts are shown on the list page; only these labels.
//
// Checks that have not finished keep their existing statuses.

export const LIST_STATUS = {
  notCheckedYet: "Not checked yet",
  unavailable: "Review status unavailable",
  noQuotations: "No quotations found",
  noIssues: "No issues found",
  inProgress: "Review in progress",
  complete: "Review complete",
} as const;

export interface ReviewCounts {
  quotations: number; // quotations the check found and checked
  issues: number; // issues on quotations marked `has_issues`
  decided: number; // of those issues, how many have a saved decision
}

// `counts` is `null` when the counts could not be loaded; the label then says so
// rather than guessing.
export function reviewListStatus(processingStatus: string, counts: ReviewCounts | null): string {
  if (processingStatus === "draft") return LIST_STATUS.notCheckedYet;
  if (processingStatus !== "complete") return processingStatus; // uploading / processing / failed / deleting

  if (!counts) return LIST_STATUS.unavailable;
  // Order matters: zero quotations is distinct from zero issues (same order as
  // `resultState` on the review page).
  if (counts.quotations === 0) return LIST_STATUS.noQuotations;
  if (counts.issues === 0) return LIST_STATUS.noIssues;
  if (counts.decided < counts.issues) return LIST_STATUS.inProgress; // includes "none decided yet"
  return LIST_STATUS.complete;
}

export interface QuotationCountRow {
  id: string;
  review_id: string;
  checking_result: string;
}

export interface IssueCountRow {
  id: string;
  review_id: string;
  quotation_id: string;
}

// Builds per-review counts for `reviewIds` from the signed-in user's rows. Rows for
// other reviews are ignored. Every requested review gets an entry, so a completed
// check with no quotations is counted as zero, not left out.
export function countReviewProgress(args: {
  reviewIds: string[];
  quotations: QuotationCountRow[];
  issues: IssueCountRow[];
  decidedIssueIds: Iterable<string>;
}): Map<string, ReviewCounts> {
  const counts = new Map<string, ReviewCounts>();
  for (const id of args.reviewIds) counts.set(id, { quotations: 0, issues: 0, decided: 0 });

  const flaggedQuotationIds = new Set<string>();
  for (const q of args.quotations) {
    const c = counts.get(q.review_id);
    if (!c) continue;
    c.quotations += 1;
    if (q.checking_result === "has_issues") flaggedQuotationIds.add(q.id);
  }

  const decided = new Set(args.decidedIssueIds);
  for (const issue of args.issues) {
    const c = counts.get(issue.review_id);
    if (!c || !flaggedQuotationIds.has(issue.quotation_id)) continue;
    c.issues += 1;
    if (decided.has(issue.id)) c.decided += 1;
  }

  return counts;
}

// ---------------------------------------------------------------------------
// Reading every row despite the API's response limit.
//
// Supabase's API returns at most `max_rows` rows per request (1000 in this
// project's config and by default on hosted), silently cutting off the rest. So
// each list is read page by page, and the total the database reports
// (`count: "exact"`) decides when we have everything. The next page starts after
// the rows actually received, so a server cap SMALLER than our page size still
// reads every row. If the total can't be confirmed, the result is `null`, and the
// page shows "Review status unavailable" rather than a wrong status.

export interface PageResult<T> {
  data: T[] | null;
  error: unknown;
  count: number | null;
}

export const PAGE_SIZE = 1000;
const MAX_PAGES = 10_000; // safety stop; far above any realistic list

export async function fetchAllRows<T>(
  fetchPage: (from: number, to: number) => PromiseLike<PageResult<T>>,
  pageSize: number = PAGE_SIZE,
): Promise<T[] | null> {
  const rows: T[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { data, error, count } = await fetchPage(rows.length, rows.length + pageSize - 1);
    if (error || !data || count === null) return null;
    rows.push(...data);
    if (rows.length === count) return rows;
    // More rows than the total, or the server reports more but sent none: the
    // data changed while we were reading. Don't guess.
    if (rows.length > count || data.length === 0) return null;
  }
  return null;
}
