// Server-side "finish the save" logic for a review.
//
// The browser uploads the .md files directly to the private `review-files`
// bucket under {userId}/{reviewId}/{filename}, then calls the server to FINISH
// the save. This module is that finish step, written framework-agnostically (it
// takes a Supabase client already acting AS the signed-in user, so Row Level
// Security applies to every call here). The thin Next server action in
// app/reviews/actions.ts wires it to the cookie-based server client.
//
// What finishing does, in order:
//   1. Re-validate the request shape (one report + >=1 transcript, each
//      transcript has a confirmed participant id, .md filenames, no duplicates).
//   2. Reconcile by IDENTITY first: if a review with this id already exists, only
//      call it saved when its stored documents MATCH this exact save (same files
//      and participant ids). A mismatch is a conflict, not a success.
//   3. Verify the files really are present AND their CONTENTS are usable: each
//      expected file exists, is non-empty, decodes as UTF-8 text, has
//      non-whitespace content, and -- for a transcript -- actually contains the
//      confirmed participant's speaker label (e.g. "P03:").
//   4. Create the review + document rows atomically via
//      create_review_with_documents(). On a duplicate-id error, reconcile by
//      matching again (never assume success). On an unknown/transient outcome,
//      report "uncertain" and KEEP the uploaded files so a retry (same id) can
//      finish.
//
// The caller maps "saved" to opening the review; every other result is shown to
// the researcher with her selections kept so she can retry.

import type { SupabaseClient } from "@supabase/supabase-js";

export const REVIEW_FILES_BUCKET = "review-files";

export type DocumentRole = "report" | "transcript";

export interface DocumentInput {
  role: DocumentRole;
  filename: string;
  /** Required (non-blank) for transcripts; ignored for the report. */
  participantId?: string | null;
}

export interface FinishSaveInput {
  reviewId: string;
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
  | { status: "file_rejected"; message: string; filename: string }
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
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  documents: DocumentInput[],
): { label: string; expected: ExpectedDocument[] } {
  const expected: ExpectedDocument[] = documents.map((d) => {
    const filename = d.filename.trim();
    return {
      role: d.role,
      filename,
      storage_path: `${userId}/${reviewId}/${filename}`,
      participant_id: d.role === "transcript" ? (d.participantId ?? "").trim() : null,
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
): Promise<{ exists: boolean; documents: ExpectedDocument[] }> {
  const { data: review } = await supabase
    .from("reviews")
    .select("id")
    .eq("id", reviewId)
    .maybeSingle();
  if (!review) return { exists: false, documents: [] };

  const { data: docs } = await supabase
    .from("documents")
    .select("role, filename, storage_path, participant_id")
    .eq("review_id", reviewId);

  const documents: ExpectedDocument[] = (docs ?? []).map((d) => ({
    role: d.role as DocumentRole,
    filename: d.filename as string,
    storage_path: d.storage_path as string,
    participant_id: (d.participant_id as string | null) ?? null,
  }));
  return { exists: true, documents };
}

type VerifyResult =
  | { ok: true }
  // Couldn't even list the folder (transient) -> treat as uncertain upstream.
  | { ok: false; kind: "list_error"; message: string }
  // Expected files that are not present in Storage -> an interrupted upload.
  | { ok: false; kind: "missing"; message: string; missing: string[] }
  // A present file whose contents are not usable -> must be replaced/corrected.
  | { ok: false; kind: "rejected"; message: string; filename: string };

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
        message: `${doc.filename} could not be read: ${downloadError?.message ?? "no data"}.`,
      };
    }

    const bytes = await blob.arrayBuffer();
    if (bytes.byteLength === 0) {
      return { ok: false, kind: "rejected", filename: doc.filename, message: `${doc.filename} is empty.` };
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return {
        ok: false,
        kind: "rejected",
        filename: doc.filename,
        message: `${doc.filename} is not readable text.`,
      };
    }
    if (text.trim().length === 0) {
      return {
        ok: false,
        kind: "rejected",
        filename: doc.filename,
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
          message: `${doc.filename} has no "${doc.participant_id}:" speaker label.`,
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

  const { label, expected } = buildExpected(userId, input.reviewId, input.documents);

  // 1) Identity-first reconciliation: if a review with this id already exists,
  //    only treat it as saved when its documents match THIS save.
  const existing = await loadExistingReview(supabase, input.reviewId);
  if (existing.exists) {
    return documentsMatch(expected, existing.documents)
      ? { status: "saved", reviewId: input.reviewId }
      : {
          status: "conflict",
          message: "A review already exists for this id with different files.",
        };
  }

  // 2) Verify the files (existence + readable contents + speaker labels).
  const verification = await verifyFiles(supabase, `${userId}/${input.reviewId}`, expected);
  if (!verification.ok) {
    if (verification.kind === "missing") {
      return { status: "upload_incomplete", message: verification.message, missing: verification.missing };
    }
    if (verification.kind === "rejected") {
      return { status: "file_rejected", message: verification.message, filename: verification.filename };
    }
    // list_error -> transient: keep files, let Anna retry the same id.
    return {
      status: "uncertain",
      message: "We couldn't confirm your save. Try again to check its status.",
    };
  }

  // 3) Create the review + documents atomically (the database function enforces
  //    the same rules and rolls back on any failure).
  const { error } = await supabase.rpc("create_review_with_documents", {
    p_review_id: input.reviewId,
    p_name: label,
    p_documents: expected.map((d) => ({
      role: d.role,
      filename: d.filename,
      storage_path: d.storage_path,
      participant_id: d.participant_id,
    })),
  });

  if (!error) return { status: "saved", reviewId: input.reviewId };

  // Duplicate id: do NOT assume success -- reconcile by matching.
  if (error.code === "23505") {
    const after = await loadExistingReview(supabase, input.reviewId);
    if (after.exists && documentsMatch(expected, after.documents)) {
      return { status: "saved", reviewId: input.reviewId };
    }
    return {
      status: "conflict",
      message: "A review already exists for this id with different files.",
    };
  }

  // Definite, data-level failures (our function's guards, constraint and type
  // errors). These should not occur after the checks above, but if they do they
  // are not retryable as-is.
  const definiteErrorCodes = new Set(["P0001", "23514", "23502", "23503", "22P02"]);
  if (error.code && definiteErrorCodes.has(error.code)) {
    return { status: "invalid", message: error.message };
  }

  // Unknown / transient (e.g. statement timeout, lost connection): the outcome
  // is uncertain, so KEEP the uploaded files and let Anna retry the same id.
  return {
    status: "uncertain",
    message: "We couldn't confirm your save. Try again to check its status.",
  };
}
