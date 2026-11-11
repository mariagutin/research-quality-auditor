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
import { wordNorms, similarity, contiguousContains } from "./text-compare";

export const REVIEW_FILES_BUCKET = "review-files";

// A reworded passage counts as a "possible source" when its word overlap reaches
// this score, and only for quotes of at least this many words (short quotes swing
// the ratio too far). Provisional, under local evaluation (see ADR-0006).
const NEAR_MATCH_THRESHOLD = 0.7;
const NEAR_MATCH_MIN_WORDS = 4;

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
  issues?: {
    issue_type: string;
    explanation?: string;
    source_document_id?: string | null;
    source_excerpt?: string | null;
  }[];
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

// The id clearly attributes the quote when it sits in the speaker role in the
// clause just before the quote. Mere co-occurrence does not count, and two
// different attributing ids are ambiguous -> empty.
//
// The credited id may be a participant WITHOUT an uploaded transcript -- e.g. the
// report credits P03 but only P05's interview was provided. That credit is still
// detected (by its participant-id shape), so the quote can be flagged as a
// participant mismatch rather than silently passing as "no issues".
const ATTRIBUTION_VERBS =
  "said|says|noted|notes|explained|explains|reported|reports|told|adds|added|recalled|remarked|observed|wrote|writes";

// The four speaker forms, built around a given id sub-pattern. The colon form is
// case-sensitive (a literal label); the others allow a capitalized sentence start.
function attributionPatterns(idPat: string, flags: string): RegExp[] {
  const i = flags.includes("i") ? flags : flags + "i";
  return [
    new RegExp(`\\b${idPat}\\s*:\\s*$`, flags), // "P03:" directly before the quote
    new RegExp(`\\b${idPat}\\s+(?:${ATTRIBUTION_VERBS})\\b`, i),
    new RegExp(`\\b${idPat}\\s+put\\s+it\\b`, i), // "as P03 put it"
    new RegExp(`\\baccording\\s+to\\s+${idPat}\\b`, i),
  ];
}

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

  // 1. Confirmed participant ids, matched exactly -- so an id of ANY shape
  //    (including one that is not "P12"-style) is still recognized as a speaker.
  for (const id of confirmedIds) {
    if (attributionPatterns(escapeRegExp(id), "").some((p) => p.test(windowText))) hits.add(id);
  }

  // 2. A participant-id-shaped token (letters then digits, e.g. P03) in the
  //    speaker slot -- so a credit to a participant with NO uploaded transcript
  //    is detected too. Fold onto a confirmed id that differs only in case.
  const ID = "([A-Za-z]+[-_]?\\d+)";
  for (const p of attributionPatterns(ID, "g")) {
    for (const m of windowText.matchAll(p)) {
      const token = m[1];
      const canon = confirmedIds.find((c) => c.toLowerCase() === token.toLowerCase());
      hits.add(canon ?? token);
    }
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

  // Flat list of participant passages (Moderator excluded), each with the
  // normalized words used for comparison, in a stable canonical order:
  // participant id, then document id, then line position. That order is the
  // documented tie-breaker when scores are equal.
  interface Passage {
    docId: string;
    participantId: string;
    lineIndex: number;
    raw: string;
    words: string[];
  }
  const passages: Passage[] = [];
  for (const t of transcripts) {
    participantLines(t.text, t.participantId).forEach((raw, lineIndex) => {
      const colon = raw.indexOf(":");
      const spoken = colon >= 0 ? raw.slice(colon + 1).trim() : raw;
      passages.push({ docId: t.documentId, participantId: t.participantId, lineIndex, raw, words: wordNorms(spoken) });
    });
  }
  passages.sort((a, b) =>
    a.participantId < b.participantId
      ? -1
      : a.participantId > b.participantId
        ? 1
        : a.docId < b.docId
          ? -1
          : a.docId > b.docId
            ? 1
            : a.lineIndex - b.lineIndex,
  );

  // The first exact passage (quote said verbatim, up to case/punctuation) among
  // those matching `pred`, in canonical order.
  const firstExact = (pred: (p: Passage) => boolean, needle: string[]): Passage | null =>
    passages.find((p) => pred(p) && contiguousContains(p.words, needle)) ?? null;

  // The highest-scoring near passage among those matching `pred`. Ties go to the
  // earlier passage in canonical order (strict `>` keeps the first seen).
  const bestNear = (pred: (p: Passage) => boolean, needle: string[]): Passage | null => {
    let best: Passage | null = null;
    let bestScore = 0;
    for (const p of passages) {
      if (!pred(p)) continue;
      const score = similarity(needle, p.words);
      if (score >= NEAR_MATCH_THRESHOLD && score > bestScore) {
        best = p;
        bestScore = score;
      }
    }
    return best;
  };

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
    const needle = wordNorms(inner);

    const base = {
      report_document_id: reportDocumentId,
      original_text: inner,
      listed_participant_id: listed,
      start_offset: start,
      end_offset: end,
    };

    // 1. EXACT matches take priority across everyone; prefer the credited
    //    participant when the report named one.
    let exact: Passage | null = listed ? firstExact((p) => p.participantId === listed, needle) : null;
    let exactMismatch = false;
    if (!exact) {
      const other = listed
        ? firstExact((p) => p.participantId !== listed, needle)
        : firstExact(() => true, needle);
      if (other) {
        exact = other;
        exactMismatch = Boolean(listed);
      }
    }

    if (exact && !exactMismatch) {
      // Verbatim in the credited participant's speech (or no participant named).
      results.push({ ...base, checking_result: "no_issues", matched_document_id: exact.docId, matched_excerpt: exact.raw });
      continue;
    }
    if (exact && exactMismatch) {
      // Said verbatim, but by someone other than the credited participant: we can
      // state this plainly because the wording is an exact match.
      results.push({
        ...base,
        checking_result: "has_issues",
        matched_document_id: exact.docId,
        matched_excerpt: exact.raw,
        issues: [
          {
            issue_type: "participant_mismatch",
            explanation: `Report attributes this quote to ${listed}, but it was said by ${exact.participantId}.`,
            source_document_id: exact.docId,
            source_excerpt: exact.raw,
          },
        ],
      });
      continue;
    }

    // 2. No exact match anywhere: look for a reworded "possible source". Only for
    //    quotes of enough words; prefer the credited participant's best passage.
    let near: Passage | null = null;
    let nearMismatch = false;
    if (needle.length >= NEAR_MATCH_MIN_WORDS) {
      near = listed ? bestNear((p) => p.participantId === listed, needle) : null;
      if (!near) {
        const other = listed
          ? bestNear((p) => p.participantId !== listed, needle)
          : bestNear(() => true, needle);
        if (other) {
          near = other;
          nearMismatch = Boolean(listed);
        }
      }
    }

    if (near && !nearMismatch) {
      // Reworded, within the credited participant (or no participant named):
      // a possible wording difference, no attribution claim.
      results.push({
        ...base,
        checking_result: "has_issues",
        matched_document_id: near.docId,
        matched_excerpt: near.raw,
        issues: [
          {
            issue_type: "wording_mismatch",
            explanation: `This quote is not word-for-word in ${near.participantId}'s transcript; the closest passage is shown as a possible source to review.`,
            source_document_id: near.docId,
            source_excerpt: near.raw,
          },
        ],
      });
      continue;
    }
    if (near && nearMismatch) {
      // Reworded AND only near another participant: keep both labels, but word
      // the attribution cautiously -- similarity does not prove who said it.
      results.push({
        ...base,
        checking_result: "has_issues",
        matched_document_id: near.docId,
        matched_excerpt: near.raw,
        issues: [
          {
            issue_type: "participant_mismatch",
            explanation: `The report credits ${listed}; a possible source passage was found in ${near.participantId}'s transcript.`,
            source_document_id: near.docId,
            source_excerpt: near.raw,
          },
          {
            issue_type: "wording_mismatch",
            explanation: `This quote is not word-for-word; the closest passage is shown as a possible source to review.`,
            source_document_id: near.docId,
            source_excerpt: near.raw,
          },
        ],
      });
      continue;
    }

    // 3. Nothing matched, exactly or closely.
    results.push({
      ...base,
      checking_result: "has_issues",
      matched_document_id: null,
      matched_excerpt: null,
      issues: [{ issue_type: "quote_not_found", explanation: "Quote not found in any participant's transcript." }],
    });
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
