// Turns the saved check rows into what the review page shows: ONLY the
// quotations that have an issue, in report order, plus a count of how many
// quotations were checked and how many had issues.
//
// Pure (rows in, view model out) so it is directly testable without a database.
// The page fetches the rows AS the signed-in user; owner-only RLS means these
// rows already belong to that researcher.

import { diffSegments, type DiffSeg } from "./text-compare";

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
  participantId?: string | null;
}

export interface IssueLabel {
  kind: string; // the raw issue_type (drives chip colour)
  label: string; // plain-language text
}

// A highlighted comparison of the report's quote against the verbatim transcript
// passage; `changed` marks the words that differ on each side.
export type Evidence =
  | {
      kind: "diff";
      filename: string;
      participantId: string | null;
      report: DiffSeg[];
      transcript: DiffSeg[];
    }
  | { kind: "plain"; filename: string; excerpt: string };

// One entry per issue. A quotation with two issues yields two entries, placed
// together, each self-contained (quotation, one label, its explanation, its own
// evidence) and tagged "Issue N of M" so the shared quotation is clear.
export interface IssueEntry {
  quotationId: string;
  quote: string;
  // The participant the report credited, when it named one.
  reportCredits: string | null;
  label: IssueLabel;
  note: string;
  evidence: Evidence | null;
  issueIndex: number; // 1-based position within this quotation's issues
  issueCount: number; // total issues on this quotation
}

export interface IssuesView {
  quotationsChecked: number;
  totalIssues: number; // each issue counted separately, incl. several on one quotation
  entries: IssueEntry[];
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
      return "Possible wording difference";
    case "participant_not_specified":
      return "No participant specified";
    default:
      return issueType;
  }
}

// Drop the "P05:" speaker label from a stored excerpt, leaving the spoken words
// (used only for the word-by-word diff; the filename and id are shown separately).
function spokenPart(excerpt: string, participantId: string | null): string {
  const colon = excerpt.indexOf(":");
  if (colon >= 0) {
    const speaker = excerpt.slice(0, colon).trim();
    if (!participantId || speaker === participantId) {
      return excerpt.slice(colon + 1).replace(/^\s+/, "");
    }
  }
  return excerpt;
}

export function buildIssuesView(args: {
  quotations: QuotationRow[];
  issues: IssueRow[];
  documents: DocumentRow[];
}): IssuesView {
  const { quotations, issues, documents } = args;

  const filenameById = new Map(documents.map((d) => [d.id, d.filename]));
  const participantById = new Map(documents.map((d) => [d.id, d.participantId ?? null]));
  const issuesByQuotation = new Map<string, IssueRow[]>();
  for (const issue of issues) {
    const list = issuesByQuotation.get(issue.quotation_id) ?? [];
    list.push(issue);
    issuesByQuotation.set(issue.quotation_id, list);
  }

  // Evidence relevant to a single issue: a wording issue gets a highlighted diff;
  // a participant mismatch gets the plain verbatim passage; quote-not-found none.
  const evidenceFor = (quote: string, issue: IssueRow): Evidence | null => {
    if (issue.source_document_id == null || issue.source_excerpt == null) return null;
    const filename = filenameById.get(issue.source_document_id) ?? "";
    const participantId = participantById.get(issue.source_document_id) ?? null;
    if (issue.issue_type === "wording_mismatch") {
      const diff = diffSegments(quote, spokenPart(issue.source_excerpt, participantId));
      return { kind: "diff", filename, participantId, report: diff.a, transcript: diff.b };
    }
    return { kind: "plain", filename, excerpt: issue.source_excerpt };
  };

  const withIssues = quotations
    .filter((q) => q.checking_result === "has_issues")
    .sort((a, b) => a.start_offset - b.start_offset);

  const entries: IssueEntry[] = [];
  let totalIssues = 0;
  for (const q of withIssues) {
    const qIssues = issuesByQuotation.get(q.id) ?? [];
    totalIssues += qIssues.length;
    qIssues.forEach((issue, idx) => {
      entries.push({
        quotationId: q.id,
        quote: q.original_text,
        reportCredits: q.listed_participant_id,
        label: { kind: issue.issue_type, label: labelFor(issue.issue_type) },
        note: issue.explanation ?? "",
        evidence: evidenceFor(q.original_text, issue),
        issueIndex: idx + 1,
        issueCount: qIssues.length,
      });
    });
  }

  return {
    quotationsChecked: quotations.length,
    totalIssues,
    entries,
  };
}
