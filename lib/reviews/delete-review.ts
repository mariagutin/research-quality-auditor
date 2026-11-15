// Deleting a review: its database records AND its Storage files, safely.
//
// Flow (see docs/adr/0008):
//   1. Acquire the delete lease with begin_review_op('deleting'). This is refused
//      while an upload or a check is ACTIVE (blocked, files preserved) and while a
//      deletion is already active (no competing deletion); it reclaims a
//      RECOVERABLE (stale / confirmed-failed) upload/check/deletion.
//   2. finalize_review_deletion creates the durable whole-prefix cleanup record AND
//      deletes the review row (cascade: documents, quotations, issues, decisions,
//      and the per-attempt upload reminders) in ONE token-fenced transaction. A
//      BEFORE DELETE guard forbids deleting the row without that successor record,
//      so dropping rows never orphans files.
//   3. Remove the files under the review's EXACT prefix {userId}/{reviewId}/. The
//      cleanup record is RETAINED for later owner-driven checks, even once the
//      folder is empty (retirement is deferred by decision).
//
// The row is deleted BEFORE the authoritative sweep: once it is gone the prefix is
// rowless and no new upload can be authorized for it (ids are never reused), so the
// file set only shrinks. An interrupted deletion (finalize committed, sweep not) is
// recovered by resumePendingDeletions, driven by the owner returning.

import type { SupabaseClient } from "@supabase/supabase-js";
import { REVIEW_FILES_BUCKET } from "./run-check";

export { REVIEW_FILES_BUCKET };

export type DeleteReviewResult =
  // The review records are deleted. `cleanupPending` is true when the file sweep
  // did not finish -- the files are not all gone yet (the owner's next visit
  // finishes them via resumePendingDeletions). The UI must NOT claim all files were
  // removed when this is true.
  | { status: "deleted"; cleanupPending: boolean }
  // An upload/check is active, or a deletion is already in progress.
  | { status: "blocked"; message: string }
  // The review does not exist (or is not the caller's).
  | { status: "not_found"; message: string }
  // The deletion did not finish; it stays recoverable. UI offers Retry.
  | { status: "error"; message: string };

const LIST_PAGE_SIZE = 100;
const REMOVE_BATCH_SIZE = 100;

// Every file key under a review's EXACT prefix {userId}/{reviewId}/, recursing into
// the per-attempt token subfolders. Never lists outside that prefix.
export async function listReviewPrefixFiles(
  supabase: SupabaseClient,
  userId: string,
  reviewId: string,
  pageSize: number = LIST_PAGE_SIZE,
): Promise<{ ok: true; paths: string[] } | { ok: false; message: string }> {
  const base = `${userId}/${reviewId}`;
  const paths: string[] = [];
  const folders: string[] = [base];
  while (folders.length > 0) {
    const prefix = folders.pop() as string;
    let offset = 0;
    for (;;) {
      const { data, error } = await supabase.storage
        .from(REVIEW_FILES_BUCKET)
        .list(prefix, { limit: pageSize, offset });
      if (error) return { ok: false, message: error.message };
      const page = data ?? [];
      for (const entry of page) {
        if (!entry.name) continue;
        const full = `${prefix}/${entry.name}`;
        // A file has an id; a folder placeholder has id === null -> recurse into it.
        if (entry.id) paths.push(full);
        else folders.push(full);
      }
      if (page.length < pageSize) break;
      offset += pageSize;
    }
  }
  return { ok: true, paths };
}

// Remove every file under the review's EXACT prefix, then confirm it is empty.
export async function sweepReviewPrefix(
  supabase: SupabaseClient,
  userId: string,
  reviewId: string,
): Promise<{ ok: boolean; message?: string }> {
  const listed = await listReviewPrefixFiles(supabase, userId, reviewId);
  if (!listed.ok) return { ok: false, message: listed.message };
  for (let i = 0; i < listed.paths.length; i += REMOVE_BATCH_SIZE) {
    const batch = listed.paths.slice(i, i + REMOVE_BATCH_SIZE);
    const { error } = await supabase.storage.from(REVIEW_FILES_BUCKET).remove(batch);
    if (error) return { ok: false, message: error.message };
  }
  const after = await listReviewPrefixFiles(supabase, userId, reviewId);
  if (!after.ok) return { ok: false, message: after.message };
  return { ok: after.paths.length === 0 };
}

// Owner-driven recovery: for each durable cleanup record, re-sweep its exact prefix.
// Records are RETAINED (not retired here), so this is safe to run repeatedly.
export async function resumePendingDeletions(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ records: number; swept: number }> {
  const { data: records } = await supabase
    .from("review_file_cleanups")
    .select("review_id")
    .eq("user_id", userId);
  let swept = 0;
  for (const r of records ?? []) {
    const res = await sweepReviewPrefix(supabase, userId, r.review_id as string);
    if (res.ok) swept += 1;
  }
  return { records: records?.length ?? 0, swept };
}

export async function deleteReview(
  supabase: SupabaseClient,
  userId: string,
  reviewId: string,
): Promise<DeleteReviewResult> {
  // 1. Acquire the delete lease. begin_review_op refuses an ACTIVE upload/check
  //    (blocked) and an active deletion (no competing); it reclaims a recoverable one.
  const { data: token } = await supabase.rpc("begin_review_op", {
    p_review_id: reviewId,
    p_op: "deleting",
  });
  if (!token) {
    const { data: now } = await supabase
      .from("reviews")
      .select("processing_status")
      .eq("id", reviewId)
      .maybeSingle();
    if (!now) return { status: "not_found", message: "This check no longer exists." };
    switch (now.processing_status) {
      case "uploading":
        return { status: "blocked", message: "An upload is in progress. You can delete this once it finishes." };
      case "processing":
        return { status: "blocked", message: "A check is running. You can delete this once it finishes." };
      case "deleting":
        return { status: "blocked", message: "A deletion is already in progress." };
      default:
        return { status: "error", message: "This check can't be deleted right now." };
    }
  }
  const opToken = token as string;

  // 2. Finalize: create the durable whole-prefix cleanup record AND delete the row
  //    (cascade) atomically, token-fenced.
  const { error: finErr } = await supabase.rpc("finalize_review_deletion", {
    p_review_id: reviewId,
    p_token: opToken,
  });
  if (finErr) {
    // Ambiguous: did finalize commit? If the row is already gone it did (lost
    // response) -- the cleanup record exists, so just sweep the files.
    const { data: still } = await supabase.from("reviews").select("id").eq("id", reviewId).maybeSingle();
    if (!still) {
      const swept = await sweepReviewPrefix(supabase, userId, reviewId);
      return { status: "deleted", cleanupPending: !swept.ok };
    }
    // The row remains: mark this delete attempt failed (fenced) so it is
    // immediately recoverable, and report an error.
    await supabase.rpc("fail_review_op", { p_review_id: reviewId, p_token: opToken });
    return { status: "error", message: "Couldn't finish deleting. It stays marked for deletion — try again." };
  }

  // 3. The records are gone and the durable cleanup record exists. Remove the files
  //    under the review's exact prefix; the record is RETAINED for later checks. If
  //    the sweep doesn't finish, the review is still deleted and the durable record
  //    lets the owner's next visit (resumePendingDeletions) finish it.
  const swept = await sweepReviewPrefix(supabase, userId, reviewId);
  return { status: "deleted", cleanupPending: !swept.ok };
}
