"use server";

// Thin server action that finishes a review save. The browser uploads the files
// directly to Storage, then calls this with the reviewId and the per-file
// metadata. All the real work (validation, file+content verification, atomic
// record creation, and duplicate/timeout reconciliation) lives in
// lib/reviews/finish-save.ts and runs AS the signed-in user, so Row Level
// Security and the owner-only Storage policies apply to every call.

import { createClient } from "@/lib/supabase/server";
import {
  finishReviewSave,
  type FinishSaveInput,
  type FinishSaveResult,
} from "@/lib/reviews/finish-save";
import { runReviewCheck, type RunCheckResult } from "@/lib/reviews/run-check";
import { setDecision, type DecisionValue, type SetDecisionResult } from "@/lib/reviews/decisions";
import { deleteReview, type DeleteReviewResult } from "@/lib/reviews/delete-review";
import { cleanupDeadAttempts, cleanupPending, removeAttemptFolder } from "@/lib/reviews/upload-cleanup";

// Creates the review row (status `uploading`) BEFORE any file is sent, and returns
// its id and lease token. The browser uploads under {uid}/{reviewId}/{opToken}/...
// and then calls finishSaveAction with the same token. Runs AS the signed-in user.
export type BeginUploadResult =
  | { status: "started"; reviewId: string; opToken: string }
  | { status: "error"; message: string };

export async function beginUploadAction(name: string): Promise<BeginUploadResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { status: "error", message: "You must be signed in to start an upload." };
  }
  const { data, error } = await supabase.rpc("begin_upload", { p_name: name });
  const row = Array.isArray(data) ? data[0] : data;
  if (error || !row?.review_id || !row?.op_token) {
    return { status: "error", message: "Couldn't start the upload. Try again." };
  }
  return { status: "started", reviewId: row.review_id as string, opToken: row.op_token as string };
}

// Full retry after a CONFIRMED upload failure: re-stamp a fresh lease on the SAME
// review id (retry_upload records a fixed-target reminder for the retired token),
// then clean up the retired attempt folders by their explicit tokens. Returns the
// new token to upload under. Runs AS the signed-in user.
export type RetryUploadResult =
  // Fresh token stamped AND retired folders cleaned: safe to transfer files.
  | { status: "retrying"; opToken: string }
  // Fresh token stamped, but cleanup did NOT finish: DO NOT transfer files. Keep
  // this token and resume cleanup (via cleanupUploadAction) before uploading.
  | { status: "cleanup_pending"; opToken: string; message: string }
  | { status: "error"; message: string };

export async function retryUploadAction(reviewId: string): Promise<RetryUploadResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { status: "error", message: "You must be signed in to retry an upload." };

  const { data: newToken, error } = await supabase.rpc("retry_upload", { p_review_id: reviewId });
  if (error || !newToken) {
    return { status: "error", message: "Couldn't start a fresh attempt. Try again." };
  }
  // Fixed-target cleanup of the retired attempt folder(s); reminders are retained.
  // If it did not fully succeed, the caller must hold off uploading and resume.
  const cleaned = await cleanupDeadAttempts(supabase, user.id, reviewId);
  if (cleanupPending(cleaned)) {
    return {
      status: "cleanup_pending",
      opToken: newToken as string,
      message: "Cleaning up the previous attempt. Try again.",
    };
  }
  return { status: "retrying", opToken: newToken as string };
}

// Resume fixed-target cleanup of a review's retired attempt folders WITHOUT starting
// a new attempt (no retry_upload). Used on resume so a failed cleanup can be retried
// before uploading, preserving the current attempt's id/token.
export async function cleanupUploadAction(reviewId: string): Promise<{ ok: boolean }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false };
  const cleaned = await cleanupDeadAttempts(supabase, user.id, reviewId);
  return { ok: !cleanupPending(cleaned) };
}

// Record a CONFIRMED upload failure immediately (so recovery need not wait for the
// staleness timeout). Fenced on the token; a no-op if superseded.
export async function failUploadAction(reviewId: string, opToken: string): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;
  await supabase.rpc("fail_review_op", { p_review_id: reviewId, p_token: opToken });
}

// Remove ONLY the files of ONE rejected upload attempt, by its exact token folder
// {uid}/{reviewId}/{opToken}/. Used after a file_rejected finish: the attempt is
// failed (fail_review_op) and we clean its own files without deleting the whole
// review. removeAttemptFolder targets a single named token folder and never "all but
// the current", so a concurrent reclaim (which always uses a NEW token) is never
// touched. Best-effort; the whole-prefix cleanup on an eventual delete is the backstop.
export async function cleanupRejectedAttemptAction(
  reviewId: string,
  opToken: string,
): Promise<{ ok: boolean }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false };
  const res = await removeAttemptFolder(supabase, user.id, reviewId, opToken);
  return { ok: res.ok };
}

// Refresh the upload lease's activity (heartbeat) while a long upload is in flight.
// Fenced on the token, so an obsolete/failed attempt cannot renew the lease.
export async function touchUploadAction(reviewId: string, opToken: string): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;
  await supabase.rpc("touch_review_op", { p_review_id: reviewId, p_token: opToken });
}

export async function finishSaveAction(
  input: FinishSaveInput,
): Promise<FinishSaveResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { status: "invalid", message: "You must be signed in to save a review." };
  }
  return finishReviewSave(supabase, user.id, input);
}

// Runs the quotation check for a review. Results + evidence are saved internally;
// only a completion/error status comes back to the browser.
export async function runCheckAction(reviewId: string): Promise<RunCheckResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { status: "error", message: "You must be signed in to run a check." };
  }
  return runReviewCheck(supabase, user.id, reviewId);
}

// Records the researcher's decision for one issue (set or switched among the
// three values). Runs AS the signed-in user; owner-only RLS applies.
export async function setDecisionAction(
  issueId: string,
  decision: DecisionValue,
): Promise<SetDecisionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { status: "error", message: "You must be signed in to record a decision." };
  }
  return setDecision(supabase, user.id, issueId, decision);
}

// Deletes a review, its files, and its related records (cascade). Runs AS the
// signed-in user; owner-only RLS applies. Files are removed and verified gone
// before any records are deleted, so a failure stays recoverable (Retry).
export async function deleteReviewAction(reviewId: string): Promise<DeleteReviewResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { status: "error", message: "You must be signed in to delete a check." };
  }
  return deleteReview(supabase, user.id, reviewId);
}
