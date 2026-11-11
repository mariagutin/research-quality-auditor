// Turns the saved check rows into what the review page shows: ONLY the
// quotations that have an issue, in report order, plus a count of how many
// quotations were checked and how many had issues.
//
// Pure (rows in, view model out) so it is directly testable without a database.
// The page fetches the rows AS the signed-in user; owner-only RLS means these
// rows already belong to that researcher.

export interface QuotationRow {
  id: string;
  original_text: string;
  listed_participant_id: string | null;
  start_offset: number;
  checking_result: "no_issues" | "has_issues";
}

export interface IssueRow {
  quotation_id: string;
  issue_type: string;
  explanation: string | null;
  source_document_id: string | null;
  source_excerpt: string | null;
}

export interface DocumentRow {
  id: string;
  filename: string;
}

export interface IssueDetail {
  type: string;
  label: string;
  explanation: string;
  // The transcript line that proves the issue, when there is one
  // (participant_mismatch has it; quote_not_found does not).
  evidence: { filename: string; excerpt: string } | null;
}

export interface IssueItem {
  quotationId: string;
  quote: string;
  // The participant the report credited, when it named one.
  reportCredits: string | null;
  issues: IssueDetail[];
}

export interface IssuesView {
  totalChecked: number;
  totalWithIssues: number;
  items: IssueItem[];
}

// Plain-language chip text per issue type. Unknown types fall back to the raw
// value so nothing silently disappears.
function labelFor(issueType: string): string {
  switch (issueType) {
    case "participant_mismatch":
      return "Participant mismatch";
    case "quote_not_found":
      return "Quote not found";
    case "wording_mismatch":
      return "Wording mismatch";
    case "participant_not_specified":
      return "No participant specified";
    default:
      return issueType;
  }
}

export function buildIssuesView(args: {
  quotations: QuotationRow[];
  issues: IssueRow[];
  documents: DocumentRow[];
}): IssuesView {
  const { quotations, issues, documents } = args;

  const filenameById = new Map(documents.map((d) => [d.id, d.filename]));
  const issuesByQuotation = new Map<string, IssueRow[]>();
  for (const issue of issues) {
    const list = issuesByQuotation.get(issue.quotation_id) ?? [];
    list.push(issue);
    issuesByQuotation.set(issue.quotation_id, list);
  }

  const withIssues = quotations
    .filter((q) => q.checking_result === "has_issues")
    .sort((a, b) => a.start_offset - b.start_offset);

  const items: IssueItem[] = withIssues.map((q) => ({
    quotationId: q.id,
    quote: q.original_text,
    reportCredits: q.listed_participant_id,
    issues: (issuesByQuotation.get(q.id) ?? []).map((issue) => {
      const filename =
        issue.source_document_id != null
          ? filenameById.get(issue.source_document_id) ?? null
          : null;
      const evidence =
        filename != null && issue.source_excerpt != null
          ? { filename, excerpt: issue.source_excerpt }
          : null;
      return {
        type: issue.issue_type,
        label: labelFor(issue.issue_type),
        explanation: issue.explanation ?? "",
        evidence,
      };
    }),
  }));

  return {
    totalChecked: quotations.length,
    totalWithIssues: withIssues.length,
    items,
  };
}
