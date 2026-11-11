// The first quotation check.
//
// Given a saved review (one report + one or more transcripts), this:
//   1. extracts the report's quotations (straight double-quoted spans),
//   2. records the report's attributed participant id ONLY when clearly stated,
//   3. looks for each quote verbatim in CONFIRMED-PARTICIPANT speech (excluding
//      Moderator and other lines),
//   4. records a "wording matched" result with the transcript evidence, or marks
//      the quote `quote_not_found` with no evidence.
//
// `analyzeReport` is pure (text in, results out) so it is directly testable.
// `runReviewCheck` wires it to Storage + the database, running AS the signed-in
// user. Results are stored internally; nothing here is shown to the researcher.

import type { SupabaseClient } from "@supabase/supabase-js";

export const REVIEW_FILES_BUCKET = "review-files";

export interface TranscriptInput {
  documentId: string;
  participantId: string;
  text: string;
}

export interface QuotationResult {
  report_document_id: string;
  original_text: string;
  listed_participant_id: string | null;
  start_offset: number;
  end_offset: number;
  checking_result: "no_issues" | "has_issues";
  matched_document_id: string | null;
  matched_excerpt: string | null;
  issues?: { issue_type: string; explanation?: string }[];
}

export type RunCheckResult =
  | { status: "complete"; quotations: number }
  | { status: "error"; message: string };

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Number of Unicode code points in text[0..utf16Index).
function codePointIndex(text: string, utf16Index: number): number {
  return Array.from(text.slice(0, utf16Index)).length;
}

// The confirmed id clearly attributes the quote when it sits in the speaker role
// in the clause just before the quote. Mere co-occurrence does not count, and two
// different attributing ids are ambiguous -> empty.
function detectAttribution(
  reportText: string,
  quoteUtf16Start: number,
  confirmedIds: string[],
): string | null {
  const prefix = reportText.slice(0, quoteUtf16Start);

  // Look at the quote's own line, and the ONE line directly above it -- but never
  // cross a blank line, and never look farther back than that single line.
  const lastNl = prefix.lastIndexOf("\n");
  const curLine = lastNl < 0 ? prefix : prefix.slice(lastNl + 1);
  let windowText = curLine;
  if (lastNl >= 0) {
    const prevNl = prefix.lastIndexOf("\n", lastNl - 1);
    const prevLine = prefix.slice(prevNl + 1, lastNl);
    if (prevLine.trim().length > 0) {
      windowText = prevLine + "\n" + curLine;
    }
  }

  // Stay within the clause attached to the quote: drop anything before the last
  // sentence end, so attribution never leaks from an earlier sentence.
  const ends = [...windowText.matchAll(/[.!?]\s/g)];
  if (ends.length > 0) {
    const last = ends[ends.length - 1];
    windowText = windowText.slice((last.index ?? 0) + last[0].length);
  }

  const hits = new Set<string>();
  for (const id of confirmedIds) {
    const e = escapeRegExp(id);
    const patterns = [
      new RegExp(`\\b${e}\\s*:\\s*$`), // "P03:" directly before the quote
      new RegExp(
        `\\b${e}\\s+(said|says|noted|notes|explained|explains|reported|reports|told|adds|added|recalled|remarked|observed|wrote|writes)\\b`,
        "i",
      ),
      new RegExp(`\\b${e}\\s+put\\s+it\\b`, "i"), // "as P03 put it"
      new RegExp(`\\baccording\\s+to\\s+${e}\\b`, "i"),
    ];
    if (patterns.some((p) => p.test(windowText))) hits.add(id);
  }
  return hits.size === 1 ? [...hits][0] : null;
}

// A transcript's lines spoken by its confirmed participant (label before the
// first colon equals the participant id). Trailing whitespace trimmed; the label
// is kept so the stored excerpt is the whole participant line.
function participantLines(text: string, participantId: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const colon = raw.indexOf(":");
    if (colon < 0) continue;
    const speaker = raw.slice(0, colon).trim();
    if (speaker === participantId) out.push(raw.replace(/\s+$/, ""));
  }
  return out;
}

export function analyzeReport(args: {
  reportDocumentId: string;
  reportText: string;
  transcripts: TranscriptInput[];
}): QuotationResult[] {
  const { reportDocumentId, reportText, transcripts } = args;
  const confirmedIds = [...new Set(transcripts.map((t) => t.participantId).filter(Boolean))];
  const perTranscript = transcripts.map((t) => ({
    documentId: t.documentId,
    lines: participantLines(t.text, t.participantId),
  }));

  const results: QuotationResult[] = [];
  const quote = /"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = quote.exec(reportText)) !== null) {
    const inner = m[1];
    if (inner.trim().length === 0) continue;

    const utf16Start = m.index + 1; // after the opening quote
    const start = codePointIndex(reportText, utf16Start);
    const end = codePointIndex(reportText, utf16Start + inner.length);
    const listed = detectAttribution(reportText, m.index, confirmedIds);

    let matchedDocumentId: string | null = null;
    let matchedExcerpt: string | null = null;
    for (const t of perTranscript) {
      const line = t.lines.find((l) => l.includes(inner));
      if (line) {
        matchedDocumentId = t.documentId;
        matchedExcerpt = line;
        break;
      }
    }

    if (matchedDocumentId) {
      results.push({
        report_document_id: reportDocumentId,
        original_text: inner,
        listed_participant_id: listed,
        start_offset: start,
        end_offset: end,
        checking_result: "no_issues",
        matched_document_id: matchedDocumentId,
        matched_excerpt: matchedExcerpt,
      });
    } else {
      results.push({
        report_document_id: reportDocumentId,
        original_text: inner,
        listed_participant_id: listed,
        start_offset: start,
        end_offset: end,
        checking_result: "has_issues",
        matched_document_id: null,
        matched_excerpt: null,
        issues: [
          {
            issue_type: "quote_not_found",
            explanation: "Quote not found in any participant's transcript.",
          },
        ],
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Orchestrator (runs as the signed-in user)
// ---------------------------------------------------------------------------

async function downloadText(supabase: SupabaseClient, path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from(REVIEW_FILES_BUCKET).download(path);
  if (error || !data) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(await data.arrayBuffer());
  } catch {
    return null;
  }
}

export async function runReviewCheck(
  supabase: SupabaseClient,
  _userId: string,
  reviewId: string,
): Promise<RunCheckResult> {
  const { data: docs, error } = await supabase
    .from("documents")
    .select("id, role, filename, storage_path, participant_id")
    .eq("review_id", reviewId);
  if (error) return { status: "error", message: "Could not load this review's files." };
  if (!docs || docs.length === 0) return { status: "error", message: "This review has no files." };

  const report = docs.find((d) => d.role === "report");
  const transcripts = docs.filter((d) => d.role === "transcript");
  if (!report) return { status: "error", message: "This review has no report." };
  if (transcripts.length === 0) return { status: "error", message: "This review has no transcripts." };

  const reportText = await downloadText(supabase, report.storage_path as string);
  if (reportText === null) return { status: "error", message: `Could not read ${report.filename}.` };

  const transcriptInputs: TranscriptInput[] = [];
  for (const t of transcripts) {
    const text = await downloadText(supabase, t.storage_path as string);
    if (text === null) return { status: "error", message: `Could not read ${t.filename}.` };
    transcriptInputs.push({
      documentId: t.id as string,
      participantId: ((t.participant_id as string | null) ?? "").trim(),
      text,
    });
  }

  const results = analyzeReport({
    reportDocumentId: report.id as string,
    reportText,
    transcripts: transcriptInputs,
  });

  const { error: rpcError } = await supabase.rpc("record_quotation_results", {
    p_review_id: reviewId,
    p_results: results,
  });
  if (rpcError) return { status: "error", message: "Could not save the check results." };

  return { status: "complete", quotations: results.length };
}
