// Server-side "finish the save" logic for a review.
//
// The browser first calls begin_upload to create the review (status `uploading`)
// and get its lease token, uploads the .md files to the private `review-files`
// bucket under {userId}/{reviewId}/{opToken}/{filename}, then calls the server to
// FINISH the save. This module is that finish step, written framework-agnostically
// (it takes a Supabase client already acting AS the signed-in user, so Row Level
// Security applies to every call here). The thin Next server action in
// app/reviews/actions.ts wires it to the cookie-based server client.
//
// What finishing does, in order:
//   1. Re-validate the request shape (one report + >=1 transcript, each
//      transcript has a confirmed participant id, .md filenames, no duplicates).
//   2. Reconcile by IDENTITY + STATE: the review already exists (begin_upload made
//      it `uploading`). If it is already `draft`, call it saved only when its
//      stored documents MATCH this exact save; a busy/other state is a conflict.
//      Only the CURRENT, non-failed `uploading` attempt (matching op_token) may be
//      finished -- a newer retry or a confirmed failure supersedes this one.
//   3. Verify the files under THIS attempt's folder are present AND their CONTENTS
//      are usable: each expected file exists, is non-empty, decodes as UTF-8 text,
//      has non-whitespace content, and -- for a transcript -- actually contains the
//      confirmed participant's speaker label (e.g. "P03:").
//   4. Insert the document rows and move `uploading` -> `draft` atomically via
//      finish_upload(reviewId, opToken, documents), fenced on the lease. If the
//      lease was lost (a retry/delete took over), reconcile by matching (never
//      assume success); on an unknown/transient outcome, report "uncertain" and
//      KEEP the files so a retry can finish.
//
// The caller maps "saved" to opening the review; every other result is shown to
// the researcher with her selections kept so she can retry.

import type { SupabaseClient } from "@supabase/supabase-js";
import { cleanupDeadAttempts, cleanupPending } from "./upload-cleanup";

export const REVIEW_FILES_BUCKET = "review-files";

export type DocumentRole = "report" | "transcript";

export interface DocumentInput {
  role: DocumentRole;
  filename: string;
  /** Required (non-blank) for transcripts; ignored for the report. */
  participantId?: string | null;
  /**
   * Stable per-row id from the client, echoed back on rejection so the UI can flag
   * the EXACT file (not every file that happens to share a name). Optional for
   * non-UI callers; defaults to the filename.
   */
  clientId?: string;
}

export interface FinishSaveInput {
  reviewId: string;
  /** The lease token returned by begin_upload; the Storage path segment too. */
  opToken: string;
  documents: DocumentInput[];
}

export type FinishSaveResult =
  // Review saved (or an identical earlier attempt reconciled) -> open it.
  | { status: "saved"; reviewId: string }
  // Request shape is wrong (should be prevented by the UI).
  | { status: "invalid"; message: string }
  // One or more files never finished uploading. UI: "Try again" and re-upload
  // ONLY the missing files under the SAME review id.
  | { status: "upload_incomplete"; message: string; missing: string[] }
  // A file uploaded but its contents are not usable (unreadable, empty, or a
  // transcript missing its confirmed speaker label). UI: replace the file or
  // correct the participant id -- which starts a NEW save (new review id).
  | { status: "file_rejected"; message: string; filename: string; documentId: string; role: DocumentRole }
  // The id exists with different files; not this save.
  | { status: "conflict"; message: string }
  // Outcome unknown (timeout/transient). UI: "We couldn't confirm your save.
  // Try again to check its status." Files are kept; an unchanged retry reuses
  // the same review id.
  | { status: "uncertain"; message: string };

interface ExpectedDocument {
  role: DocumentRole;
  filename: string;
  storage_path: string;
  participant_id: string | null;
  clientId: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Pure safeguard for the checker's turn parsing: a transcript may use only the
// confirmed participant's label and "Moderator:". Returns the FIRST conflicting
// speaker label (a participant-id-shaped token that is neither), or null when there
// is none. Without this, a stray "P03:" line in P05's transcript would be read as
// a different speaker's turn and dropped from P05's speech -- we reject it up front
// so the researcher can fix the file. A non-id-shaped role word (e.g. "Interviewer:")
// is intentionally not treated as a label here (it would collide with ordinary
// speech like "Honestly:"); only "Moderator" and id-shaped tokens are labels. Keep
// this in lockstep with turnSpeaker() in run-check.ts. (See ADR-0006.)
export function findConflictingSpeakerLabel(text: string, participantId: string): string | null {
  const labelLine = /^[ \t]*([A-Za-z]+[-_]?\d+|[Mm]oderator)[ \t]*:/;
  for (const raw of text.split(/\r?\n/)) {
    const m = labelLine.exec(raw);
    if (!m) continue;
    const token = m[1];
    if (token === participantId) continue;
    if (token.toLowerCase() === "moderator") continue;
    return token;
  }
  return null;
}

function deriveLabel(reportFilename: string): string {
  const base = reportFilename.replace(/\.md$/i, "").trim();
  return base || reportFilename.trim() || "Untitled check";
}

function validateShape(
  documents: DocumentInput[],
): { ok: true } | { ok: false; message: string } {
  if (!Array.isArray(documents) || documents.length === 0) {
    return { ok: false, message: "There are no files to save." };
  }
  const reports = documents.filter((d) => d.role === "report");
  const transcripts = documents.filter((d) => d.role === "transcript");
  if (reports.length !== 1) {
    return { ok: false, message: "Exactly one report is required." };
  }
  if (transcripts.length < 1) {
    return { ok: false, message: "At least one transcript is required." };
  }
  const names = new Set<string>();
  for (const d of documents) {
    const filename = (d.filename ?? "").trim();
    if (!filename) return { ok: false, message: "Every file needs a filename." };
    if (!/\.md$/i.test(filename)) {
      return { ok: false, message: `Only .md files are allowed: ${filename}` };
    }
    if (names.has(filename)) {
      return { ok: false, message: `Two files share a filename: ${filename}` };
    }
    names.add(filename);
  }
  for (const t of transcripts) {
    if (!(t.participantId ?? "").trim()) {
      return { ok: false, message: "Each transcript needs a confirmed participant id." };
    }
  }
  return { ok: true };
}

function buildExpected(
  userId: string,
  reviewId: string,
  opToken: string,
  documents: DocumentInput[],
): { label: string; expected: ExpectedDocument[] } {
  const expected: ExpectedDocument[] = documents.map((d) => {
    const filename = d.filename.trim();
    return {
      role: d.role,
      filename,
      // Per-attempt token subfolder: {uid}/{reviewId}/{opToken}/{filename}.
      storage_path: `${userId}/${reviewId}/${opToken}/${filename}`,
      participant_id: d.role === "transcript" ? (d.participantId ?? "").trim() : null,
      clientId: d.clientId ?? filename,
    };
  });
  const report = expected.find((d) => d.role === "report")!;
  return { label: deriveLabel(report.filename), expected };
}

function documentKey(d: ExpectedDocument): string {
  return `${d.role}|${d.filename}|${d.storage_path}|${d.participant_id ?? ""}`;
}

/** True when the stored documents are exactly the set this save expects. */
function documentsMatch(expected: ExpectedDocument[], stored: ExpectedDocument[]): boolean {
  if (expected.length !== stored.length) return false;
  const a = expected.map(documentKey).sort();
  const b = stored.map(documentKey).sort();
  return a.every((key, i) => key === b[i]);
}

// ---------------------------------------------------------------------------
// Data access (all under the caller's RLS, i.e. as the signed-in user)
// ---------------------------------------------------------------------------

async function loadExistingReview(
  supabase: SupabaseClient,
  reviewId: string,
): Promise<{
  exists: boolean;
  status: string | null;
  opToken: string | null;
  opFailed: boolean;
  documents: ExpectedDocument[];
}> {
  const { data: review } = await supabase
    .from("reviews")
    .select("id, processing_status, op_token, op_failed_at")
    .eq("id", reviewId)
    .maybeSingle();
  if (!review) return { exists: false, status: null, opToken: null, opFailed: false, documents: [] };

  const { data: docs } = await supabase
    .from("documents")
    .select("role, filename, storage_path, participant_id")
    .eq("review_id", reviewId);

  const documents: ExpectedDocument[] = (docs ?? []).map((d) => ({
    role: d.role as DocumentRole,
    filename: d.filename as string,
    storage_path: d.storage_path as string,
    participant_id: (d.participant_id as string | null) ?? null,
    // Not sent by the client for stored rows and never compared (see documentKey);
    // a filename default keeps the shape without affecting documentsMatch.
    clientId: d.filename as string,
  }));
  return {
    exists: true,
    status: (review.processing_status as string | null) ?? null,
    opToken: (review.op_token as string | null) ?? null,
    opFailed: (review.op_failed_at as string | null) != null,
    documents,
  };
}

type VerifyResult =
  | { ok: true }
  // Couldn't even list the folder (transient) -> treat as uncertain upstream.
  | { ok: false; kind: "list_error"; message: string }
  // Expected files that are not present in Storage -> an interrupted upload.
  | { ok: false; kind: "missing"; message: string; missing: string[] }
  // A present file whose contents are not usable -> must be replaced/corrected.
  | { ok: false; kind: "rejected"; message: string; filename: string; clientId: string; role: DocumentRole };

/**
 * Verify every expected file is present under the review's folder AND that its
 * CONTENTS are usable. The Storage LISTING is the arbiter of "did it finish
 * uploading": anything expected but absent is an interrupted upload (retryable
 * under the same review id). A file that IS present but fails a content check (a
 * file can be larger than zero bytes yet still be unreadable) is rejected and
 * must be replaced or its id corrected -- a new save.
 */
async function verifyFiles(
  supabase: SupabaseClient,
  prefix: string,
  expected: ExpectedDocument[],
): Promise<VerifyResult> {
  const { data: listing, error: listError } = await supabase.storage
    .from(REVIEW_FILES_BUCKET)
    .list(prefix, { limit: 1000 });
  if (listError) {
    return { ok: false, kind: "list_error", message: listError.message };
  }
  const present = new Set((listing ?? []).map((o) => o.name));

  // 1) Presence first: collect everything that didn't finish uploading.
  const missing = expected.filter((d) => !present.has(d.filename)).map((d) => d.filename);
  if (missing.length > 0) {
    const label = missing.length === 1 ? `${missing[0]} didn't` : `${missing.length} files didn't`;
    return { ok: false, kind: "missing", missing, message: `${label} finish uploading.` };
  }

  // 2) Contents of the present files.
  for (const doc of expected) {
    const { data: blob, error: downloadError } = await supabase.storage
      .from(REVIEW_FILES_BUCKET)
      .download(doc.storage_path);
    if (downloadError || !blob) {
      return {
        ok: false,
        kind: "rejected",
        filename: doc.filename,
        clientId: doc.clientId,
        role: doc.role,
        message: `${doc.filename} could not be read: ${downloadError?.message ?? "no data"}.`,
      };
    }

    const bytes = await blob.arrayBuffer();
    if (bytes.byteLength === 0) {
      return { ok: false, kind: "rejected", filename: doc.filename, clientId: doc.clientId, role: doc.role, message: `${doc.filename} is empty.` };
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return {
        ok: false,
        kind: "rejected",
        filename: doc.filename,
        clientId: doc.clientId,
        role: doc.role,
        message: `${doc.filename} is not readable text.`,
      };
    }
    if (text.trim().length === 0) {
      return {
        ok: false,
        kind: "rejected",
        filename: doc.filename,
        clientId: doc.clientId,
        role: doc.role,
        message: `${doc.filename} has no readable content.`,
      };
    }

    if (doc.role === "transcript" && doc.participant_id) {
      // The confirmed participant must appear as a speaker label, e.g. "P03:".
      const speakerLabel = new RegExp(
        `^[ \\t]*${escapeRegExp(doc.participant_id)}[ \\t]*:`,
        "m",
      );
      if (!speakerLabel.test(text)) {
        return {
          ok: false,
          kind: "rejected",
          filename: doc.filename,
          clientId: doc.clientId,
          role: doc.role,
          message: `${doc.filename} has no "${doc.participant_id}:" speaker label.`,
        };
      }
      // No OTHER participant's label may appear, or the checker would read that
      // speaker's turn as part of this participant's speech.
      const conflict = findConflictingSpeakerLabel(text, doc.participant_id);
      if (conflict) {
        return {
          ok: false,
          kind: "rejected",
          filename: doc.filename,
          clientId: doc.clientId,
          role: doc.role,
          message: `${doc.filename} has an unexpected "${conflict}:" speaker label; a transcript may use only "${doc.participant_id}:" and "Moderator:".`,
        };
      }
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function finishReviewSave(
  supabase: SupabaseClient,
  userId: string,
  input: FinishSaveInput,
): Promise<FinishSaveResult> {
  const shape = validateShape(input.documents);
  if (!shape.ok) return { status: "invalid", message: shape.message };

  const { expected } = buildExpected(userId, input.reviewId, input.opToken, input.documents);

  // 1) Reconcile by identity + state. begin_upload created the review as
  //    `uploading` before any file was sent, so it should already exist.
  const existing = await loadExistingReview(supabase, input.reviewId);
  if (!existing.exists) {
    return { status: "uncertain", message: "We couldn't find this upload. Try again." };
  }

  // Already finished by an earlier attempt: `saved` only if the stored documents
  // match THIS save; any other stored set for this id is a conflict.
  if (existing.status === "draft") {
    return documentsMatch(expected, existing.documents)
      ? { status: "saved", reviewId: input.reviewId }
      : { status: "conflict", message: "A review already exists for this id with different files." };
  }
  if (existing.status === "processing") {
    return { status: "conflict", message: "A check is running for this review." };
  }
  if (existing.status === "complete") {
    return { status: "conflict", message: "This review has already been checked." };
  }
  if (existing.status === "deleting") {
    return { status: "conflict", message: "This review is being deleted." };
  }
  if (existing.status !== "uploading") {
    return { status: "conflict", message: "This upload can no longer be finished." };
  }

  // Still uploading: only the CURRENT, non-failed attempt may finish. A newer
  // retry (different op_token) or a confirmed failure supersedes this one.
  if (existing.opToken !== input.opToken || existing.opFailed) {
    return { status: "conflict", message: "This upload was superseded by a newer attempt." };
  }

  // 2) Verify the files under THIS attempt's folder (presence + readable contents).
  const verification = await verifyFiles(
    supabase,
    `${userId}/${input.reviewId}/${input.opToken}`,
    expected,
  );
  if (!verification.ok) {
    if (verification.kind === "missing") {
      return { status: "upload_incomplete", message: verification.message, missing: verification.missing };
    }
    if (verification.kind === "rejected") {
      return {
        status: "file_rejected",
        message: verification.message,
        filename: verification.filename,
        documentId: verification.clientId,
        role: verification.role,
      };
    }
    // list_error -> transient: keep files, let the researcher retry.
    return {
      status: "uncertain",
      message: "We couldn't confirm your save. Try again to check its status.",
    };
  }

  // 2b) Finish gate: any RETIRED attempt folder must be currently empty before we
  //     complete this upload. Clean each by its explicit token (reminders retained).
  const cleaned = await cleanupDeadAttempts(supabase, userId, input.reviewId);
  if (cleanupPending(cleaned)) {
    return {
      status: "uncertain",
      message: "Finishing cleanup of a previous attempt. Try again.",
    };
  }

  // 3) Insert the documents and move uploading -> draft atomically, fenced on the
  //    upload lease (finish_upload refuses a superseded or confirmed-failed token).
  const { error } = await supabase.rpc("finish_upload", {
    p_review_id: input.reviewId,
    p_token: input.opToken,
    p_documents: expected.map((d) => ({
      role: d.role,
      filename: d.filename,
      storage_path: d.storage_path,
      participant_id: d.participant_id,
    })),
  });

  if (!error) return { status: "saved", reviewId: input.reviewId };

  // Lease lost (P0001): a retry/delete took over between our checks and finish.
  // If a prior attempt already saved identical documents, that is still a success.
  if (error.code === "P0001") {
    const after = await loadExistingReview(supabase, input.reviewId);
    if (after.exists && after.status === "draft" && documentsMatch(expected, after.documents)) {
      return { status: "saved", reviewId: input.reviewId };
    }
    return { status: "conflict", message: "This upload was superseded." };
  }

  // Definite, data-level failures (constraint / type errors). Not retryable as-is.
  const definiteErrorCodes = new Set(["23514", "23502", "23503", "22P02"]);
  if (error.code && definiteErrorCodes.has(error.code)) {
    return { status: "invalid", message: error.message };
  }

  // Unknown / transient (e.g. statement timeout, lost connection): uncertain, so
  // KEEP the uploaded files and let the researcher retry.
  return {
    status: "uncertain",
    message: "We couldn't confirm your save. Try again to check its status.",
  };
}
