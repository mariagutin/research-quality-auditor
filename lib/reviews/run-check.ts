// The first quotation check.
//
// Given a saved review (one report + one or more transcripts), this:
//   1. extracts the report's quotations (straight double-quoted spans),
//   2. records the report's attributed participant id ONLY when clearly stated,
//   3. looks for each quote in each CONFIRMED-PARTICIPANT TURN read in full --
//      verbatim, else a best-fitting near match (Moderator/other speakers excluded),
//   4. records a "wording matched" result with the transcript evidence, or marks
//      the quote `quote_not_found` with no evidence.
//
// `analyzeReport` is pure (text in, results out) so it is directly testable.
// `runReviewCheck` wires it to Storage + the database, running AS the signed-in
// user. Results are stored internally; nothing here is shown to the researcher.

import type { SupabaseClient } from "@supabase/supabase-js";
import { wordNorms, contiguousContains, bestWindow } from "./text-compare";
import { transcriptCountError, fileSizeError, totalSizeError } from "./budgets";

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
  // Results saved; review is `complete`.
  | { status: "complete"; quotations: number }
  // A CONFIRMED failure (bad state, unreadable files, or an unexpected exception):
  // the lease is released to `failed` via the token-fenced path.
  | { status: "error"; message: string }
  // The results-save outcome is UNKNOWN (we couldn't confirm it committed). Kept
  // distinct from a confirmed failure; the review is reconciled by state.
  | { status: "uncertain"; message: string };

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

// Is this line a VALID speaker label, and if so, whose turn does it start? A valid
// label is the confirmed participant id, "Moderator" (case-insensitive), or any
// participant-id-shaped token (letters then digits, e.g. P03) before the first
// colon. A colon inside ordinary speech ("Honestly: ...", "First: ...") is NOT a
// valid label (the pre-colon text isn't one of those), so it never starts a turn.
function turnSpeaker(line: string, participantId: string): string | null {
  const colon = line.indexOf(":");
  if (colon < 0) return null;
  const token = line.slice(0, colon).trim();
  if (token.length === 0) return null;
  if (token === participantId) return participantId;
  if (token.toLowerCase() === "moderator") return "Moderator";
  if (/^[A-Za-z]+[-_]?\d+$/.test(token)) return token; // another participant id
  return null; // ordinary speech with a colon -> continuation, not a new turn
}

interface Turn {
  speaker: string;
  raw: string; // verbatim turn: label line + continuation lines (trailing ws trimmed per line)
  words: string[]; // normalized spoken words across the WHOLE turn (first-line label stripped)
}

// Split a transcript into speaker TURNS. A turn starts at a valid speaker label and
// runs through every continuation line until the NEXT valid label (or end of file),
// so a quotation on a continuation line -- or spanning the label/continuation break
// -- is read as one passage. ANY valid label ends the current turn, including a
// different participant id or the same participant starting again, so a stray "P03:"
// can never be absorbed into P05's speech (upload validation also rejects such a
// file; this is the in-checker safeguard). Moderator/other-speaker turns are kept
// for segmentation but excluded from matching by the caller. See ADR-0006.
function participantTurns(text: string, participantId: string): Turn[] {
  const turns: Turn[] = [];
  let rawLines: string[] = [];
  let spokenParts: string[] = [];
  let speaker: string | null = null;
  const flush = () => {
    if (speaker !== null) {
      // Trim trailing blank continuation lines (e.g. the file's final newline) so the
      // stored turn ends at its last real content.
      const raw = rawLines.join("\n").replace(/\s+$/, "");
      turns.push({ speaker, raw, words: wordNorms(spokenParts.join(" ")) });
    }
  };
  for (const raw of text.split(/\r?\n/)) {
    const label = turnSpeaker(raw, participantId);
    if (label !== null) {
      flush();
      speaker = label;
      rawLines = [raw.replace(/\s+$/, "")];
      spokenParts = [raw.slice(raw.indexOf(":") + 1)];
    } else if (speaker !== null) {
      rawLines.push(raw.replace(/\s+$/, ""));
      spokenParts.push(raw);
    }
    // else: preamble before the first speaker label -> ignored
  }
  flush();
  return turns;
}

export function analyzeReport(args: {
  reportDocumentId: string;
  reportText: string;
  transcripts: TranscriptInput[];
}): QuotationResult[] {
  const { reportDocumentId, reportText, transcripts } = args;
  const confirmedIds = [...new Set(transcripts.map((t) => t.participantId).filter(Boolean))];

  // Flat list of participant passages -- one per PARTICIPANT TURN (Moderator and
  // other speakers excluded) -- each with the normalized words used for comparison,
  // in a stable canonical order: participant id, then document id, then turn
  // position. That order is the documented tie-breaker when scores are equal.
  interface Passage {
    docId: string;
    participantId: string;
    turnIndex: number;
    raw: string;
    words: string[];
  }
  const passages: Passage[] = [];
  for (const t of transcripts) {
    participantTurns(t.text, t.participantId)
      .filter((turn) => turn.speaker === t.participantId) // Moderator / other speakers excluded
      .forEach((turn, turnIndex) => {
        passages.push({
          docId: t.documentId,
          participantId: t.participantId,
          turnIndex,
          raw: turn.raw,
          words: turn.words,
        });
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
            : a.turnIndex - b.turnIndex,
  );

  // The first exact passage (quote said verbatim, up to case/punctuation) among
  // those matching `pred`, in canonical order.
  const firstExact = (pred: (p: Passage) => boolean, needle: string[]): Passage | null =>
    passages.find((p) => pred(p) && contiguousContains(p.words, needle)) ?? null;

  // The highest-scoring near passage among those matching `pred`. Within each turn
  // the quote is scored against its best-fitting WINDOW (fitting alignment), not the
  // whole turn, so a long turn does not dilute the score and a stray matching word
  // far away does not stretch the candidate. Ties go to the earlier passage in
  // canonical order (strict `>` keeps the first seen).
  const bestNear = (pred: (p: Passage) => boolean, needle: string[]): Passage | null => {
    let best: Passage | null = null;
    let bestScore = 0;
    for (const p of passages) {
      if (!pred(p)) continue;
      const w = bestWindow(needle, p.words);
      if (w && w.score >= NEAR_MATCH_THRESHOLD && w.score > bestScore) {
        best = p;
        bestScore = w.score;
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
  // Test-only seams (production callers omit them): a faster heartbeat interval and
  // hooks to inject a delay or interfere right before analysis / the results save.
  options: {
    heartbeatMs?: number;
    beforeAnalyze?: () => Promise<void>;
    beforeSave?: () => Promise<void>;
  } = {},
): Promise<RunCheckResult> {
  // Acquire the processing lease atomically (database-time staleness, fresh token).
  // begin_review_op allows this ONLY from draft/failed or a recoverable (stale)
  // processing; NEVER from complete (no re-run), uploading (finish first), an active
  // processing, or deleting. The returned token fences every write below.
  const { data: token, error: beginErr } = await supabase.rpc("begin_review_op", {
    p_review_id: reviewId,
    p_op: "processing",
  });
  if (beginErr) return { status: "error", message: "Could not start the check." };
  if (!token) {
    const { data: now } = await supabase
      .from("reviews")
      .select("processing_status")
      .eq("id", reviewId)
      .maybeSingle();
    if (!now) return { status: "error", message: "This check no longer exists." };
    switch (now.processing_status) {
      case "complete":
        return { status: "error", message: "This check has already been run." };
      case "processing":
        return { status: "error", message: "This check is already running." };
      case "deleting":
        return { status: "error", message: "This check is being deleted." };
      case "uploading":
        return { status: "error", message: "This review is still uploading." };
      default:
        return { status: "error", message: "This check can't run right now." };
    }
  }
  const opToken = token as string;

  // A single heartbeat. Our installed Supabase client's rpc() is LAZY -- it only
  // sends the request when the returned builder is awaited/then-ed -- so we MUST
  // await it here; a non-awaited `void supabase.rpc(...)` would never fire. Errors
  // are swallowed: the heartbeat is best-effort and must not fail the check.
  // touch_review_op is token-fenced, so only THIS attempt renews the lease.
  const heartbeatOnce = async () => {
    try {
      await supabase.rpc("touch_review_op", { p_review_id: reviewId, p_token: opToken });
    } catch {
      /* best-effort */
    }
  };
  const heartbeat = setInterval(() => {
    void heartbeatOnce();
  }, options.heartbeatMs ?? 25_000);

  // Confirmed failure: release the lease to `failed` (fenced on our token, so a
  // superseded attempt's failure never clobbers the current one).
  const fail = async (message: string): Promise<RunCheckResult> => {
    await supabase.rpc("fail_review_op", { p_review_id: reviewId, p_token: opToken });
    return { status: "error", message };
  };

  try {
    const { data: docs, error } = await supabase
      .from("documents")
      .select("id, role, filename, storage_path, participant_id")
      .eq("review_id", reviewId);
    if (error) return await fail("Could not load this review's files.");
    if (!docs || docs.length === 0) return await fail("This review has no files.");

    const report = docs.find((d) => d.role === "report");
    const transcripts = docs.filter((d) => d.role === "transcript");
    if (!report) return await fail("This review has no report.");
    if (transcripts.length === 0) return await fail("This review has no transcripts.");

    // SEC-02 (check boundary): re-verify the file-count and size budget before the
    // expensive download + analysis. Save already enforced this; re-checking here
    // is defense in depth (e.g. if limits tightened after a review was saved).
    const countErr = transcriptCountError(transcripts.length);
    if (countErr) return await fail(countErr);
    const folder = (report.storage_path as string).replace(/\/[^/]*$/, "");
    const { data: listing } = await supabase.storage.from(REVIEW_FILES_BUCKET).list(folder, { limit: 1000 });
    if (listing) {
      const sizeByName = new Map<string, number>();
      for (const o of listing) {
        const size = (o as { metadata?: { size?: number } | null }).metadata?.size;
        if (typeof size === "number") sizeByName.set(o.name, size);
      }
      const sized = docs
        .filter((d) => sizeByName.has(d.filename as string))
        .map((d) => ({ filename: d.filename as string, bytes: sizeByName.get(d.filename as string)! }));
      if (sized.length === docs.length) {
        const tooBig = fileSizeError(sized);
        if (tooBig) return await fail(tooBig.message);
        const over = totalSizeError(sized);
        if (over) return await fail(over);
      }
    }

    const reportText = await downloadText(supabase, report.storage_path as string);
    if (reportText === null) return await fail(`Could not read ${report.filename}.`);

    const transcriptInputs: TranscriptInput[] = [];
    for (const t of transcripts) {
      const text = await downloadText(supabase, t.storage_path as string);
      if (text === null) return await fail(`Could not read ${t.filename}.`);
      transcriptInputs.push({
        documentId: t.id as string,
        participantId: ((t.participant_id as string | null) ?? "").trim(),
        text,
      });
      // Touch at each file boundary too (covers a long multi-file download).
      await heartbeatOnce();
    }

    await options.beforeAnalyze?.();

    const results = analyzeReport({
      reportDocumentId: report.id as string,
      reportText,
      transcripts: transcriptInputs,
    });

    await options.beforeSave?.();

    // record_quotation_results is FENCED on the token: an outdated attempt (whose
    // lease was taken over) cannot save results or flip the status. It sets the
    // review to 'complete' only on success, in the same transaction as the results.
    const { error: rpcError } = await supabase.rpc("record_quotation_results", {
      p_review_id: reviewId,
      p_results: results,
      p_op_token: opToken,
    });

    if (rpcError) {
      // We cannot be sure the save committed. Reconcile by state -- this is an
      // UNCERTAIN result-save outcome, kept distinct from a confirmed failure.
      const { data: after } = await supabase
        .from("reviews")
        .select("processing_status, op_token")
        .eq("id", reviewId)
        .maybeSingle();
      if (after?.processing_status === "complete") {
        // It actually saved; only the response was lost.
        return { status: "complete", quotations: results.length };
      }
      // Still ours and not complete -> release the lease (fenced). If a takeover
      // changed the token, leave it to that attempt (fenced fail would no-op).
      if (after?.op_token === opToken) {
        await supabase.rpc("fail_review_op", { p_review_id: reviewId, p_token: opToken });
      }
      return {
        status: "uncertain",
        message: "We couldn't confirm the check results were saved. Try again to check its status.",
      };
    }

    return { status: "complete", quotations: results.length };
  } catch {
    // An unexpected exception from a download or the analysis is a CONFIRMED
    // failure, routed through the token-fenced failure path.
    return await fail("The check failed unexpectedly. Try again.");
  } finally {
    // Always stop the heartbeat, on every path.
    clearInterval(heartbeat);
  }
}
