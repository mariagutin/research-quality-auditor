// Turns the saved check rows into what the review page shows: ONLY the
// quotations that have an issue, in report order, plus a count of how many
// quotations were checked and how many had issues.
//
// Pure (rows in, view model out) so it is directly testable without a database.
// The page fetches the rows AS the signed-in user; owner-only RLS means these
// rows already belong to that researcher.

import { diffSegments, fittingWindow, wordNorms, segmentText, type DiffSeg } from "./text-compare";
import type { DecisionValue } from "./decisions";

export interface QuotationRow {
  id: string;
  original_text: string;
  listed_participant_id: string | null;
  start_offset: number;
  checking_result: "no_issues" | "has_issues";
}

export interface IssueRow {
  id: string;
  quotation_id: string;
  issue_type: string;
  explanation: string | null;
  source_document_id: string | null;
  source_excerpt: string | null;
}

export interface DecisionRow {
  issue_id: string;
  decision: DecisionValue;
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
  issueId: string;
  quotationId: string;
  quote: string;
  // The participant the report credited, when it named one.
  reportCredits: string | null;
  label: IssueLabel;
  note: string;
  evidence: Evidence | null;
  issueIndex: number; // 1-based position within this quotation's issues
  issueCount: number; // total issues on this quotation
  decision: DecisionValue | null; // the researcher's saved decision, if any
}

export interface IssuesView {
  quotationsChecked: number;
  totalIssues: number; // each issue counted separately, incl. several on one quotation
  reviewedCount: number; // issues with a saved decision
  entries: IssueEntry[];
}

// The single source of truth for which of the three result states the view is in, so
// the results page and its test agree. Order matters: zero quotations is distinct from
// zero issues.
//   - "no_quotations": the report had no quotations to check (TR-18)
//   - "no_issues": quotations were checked and all matched, none flagged (TR-17)
//   - "has_issues": at least one issue to review
export type ResultState = "no_quotations" | "no_issues" | "has_issues";

export function resultState(view: IssuesView): ResultState {
  if (view.quotationsChecked === 0) return "no_quotations";
  if (view.entries.length === 0) return "no_issues";
  return "has_issues";
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

// Drop the first-line "P05:" speaker label from a stored turn, leaving the spoken
// text (the filename and id are shown separately). Continuation lines are kept.
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

// Verbatim slice of `text` covering word indices [start, end] inclusive, with the
// whitespace between those words -- isolates the candidate passage from the turn.
function sliceWordsVerbatim(text: string, start: number, end: number): string {
  let w = -1;
  let inRange = false;
  const parts: string[] = [];
  for (const s of segmentText(text)) {
    if (s.isWord) {
      w += 1;
      inRange = w >= start && w <= end;
      if (inRange) parts.push(s.text);
    } else if (inRange) {
      parts.push(s.text);
    }
  }
  return parts.join("");
}

// The whole turn as diff segments, but with `changed` set ONLY for words inside the
// candidate window [start, end]; every word outside it is plain, unhighlighted
// context -- so surrounding text is never shown as a wording change.
function highlightWindow(text: string, start: number, end: number, candChanged: boolean[]): DiffSeg[] {
  let w = -1;
  return segmentText(text).map((s) => {
    if (!s.isWord) return { text: s.text, changed: false };
    w += 1;
    const changed = w >= start && w <= end ? (candChanged[w - start] ?? false) : false;
    return { text: s.text, changed };
  });
}

export function buildIssuesView(args: {
  quotations: QuotationRow[];
  issues: IssueRow[];
  documents: DocumentRow[];
  decisions?: DecisionRow[];
}): IssuesView {
  const { quotations, issues, documents, decisions = [] } = args;

  const filenameById = new Map(documents.map((d) => [d.id, d.filename]));
  const participantById = new Map(documents.map((d) => [d.id, d.participantId ?? null]));
  const decisionByIssue = new Map(decisions.map((d) => [d.issue_id, d.decision]));
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
      // The stored excerpt is the FULL participant turn. Highlight differences only
      // within the best-fitting candidate window, recomputed here with the SAME
      // fitting alignment used to score the match; show the rest of the turn as
      // plain context. So the report word ("time") and the source word ("hours")
      // are highlighted against each other, and unrelated context is not.
      const spoken = spokenPart(issue.source_excerpt, participantId);
      const win = fittingWindow(wordNorms(quote), wordNorms(spoken));
      if (!win) {
        const diff = diffSegments(quote, spoken);
        return { kind: "diff", filename, participantId, report: diff.a, transcript: diff.b };
      }
      const candidate = sliceWordsVerbatim(spoken, win.start, win.end);
      const diff = diffSegments(quote, candidate);
      const candChanged: boolean[] = [];
      segmentText(candidate).forEach((s, i) => {
        if (s.isWord) candChanged.push(diff.b[i].changed);
      });
      const transcript = highlightWindow(spoken, win.start, win.end, candChanged);
      return { kind: "diff", filename, participantId, report: diff.a, transcript };
    }
    return { kind: "plain", filename, excerpt: issue.source_excerpt };
  };

  const withIssues = quotations
    .filter((q) => q.checking_result === "has_issues")
    .sort((a, b) => a.start_offset - b.start_offset);

  const entries: IssueEntry[] = [];
  let totalIssues = 0;
  let reviewedCount = 0;
  for (const q of withIssues) {
    const qIssues = issuesByQuotation.get(q.id) ?? [];
    totalIssues += qIssues.length;
    qIssues.forEach((issue, idx) => {
      const decision = decisionByIssue.get(issue.id) ?? null;
      if (decision) reviewedCount += 1;
      entries.push({
        issueId: issue.id,
        quotationId: q.id,
        quote: q.original_text,
        reportCredits: q.listed_participant_id,
        label: { kind: issue.issue_type, label: labelFor(issue.issue_type) },
        note: issue.explanation ?? "",
        evidence: evidenceFor(q.original_text, issue),
        issueIndex: idx + 1,
        issueCount: qIssues.length,
        decision,
      });
    });
  }

  return {
    quotationsChecked: quotations.length,
    totalIssues,
    reviewedCount,
    entries,
  };
}
