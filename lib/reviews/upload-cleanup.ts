// Fixed-target cleanup of RETIRED upload-attempt folders.
//
// When retry_upload retires an attempt's token T_old and stamps T_new, it records
// one durable reminder row in review_dead_upload_attempts(review_id, token=T_old).
// This module removes the files under each *named* retired token folder
//     {userId}/{reviewId}/{token}/
// and NEVER "every folder except the current one", so a cleanup that is slow or
// interleaved with a newer attempt (T_new, or a later T_newer) can never delete the
// current attempt's files: the live op_token is never a reminder, so it is never a
// target. Reminders are RETAINED after the folder is emptied (retirement is
// deferred by decision), so a later check can re-verify them cheaply.

import type { SupabaseClient } from "@supabase/supabase-js";
import { REVIEW_FILES_BUCKET } from "./finish-save";

const LIST_PAGE_SIZE = 100;
const REMOVE_BATCH_SIZE = 100;

async function listFolderFiles(
  supabase: SupabaseClient,
  prefix: string,
): Promise<{ ok: true; paths: string[] } | { ok: false; message: string }> {
  const paths: string[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase.storage
      .from(REVIEW_FILES_BUCKET)
      .list(prefix, { limit: LIST_PAGE_SIZE, offset });
    if (error) return { ok: false, message: error.message };
    const page = data ?? [];
    for (const object of page) {
      if (object.name) paths.push(`${prefix}/${object.name}`);
    }
    if (page.length < LIST_PAGE_SIZE) break;
    offset += LIST_PAGE_SIZE;
  }
  return { ok: true, paths };
}

// Remove the files under ONE explicitly named retired attempt folder, then confirm
// it is empty. This is the fixed single target; it touches no other token folder.
export async function removeAttemptFolder(
  supabase: SupabaseClient,
  userId: string,
  reviewId: string,
  token: string,
): Promise<{ ok: true; emptied: boolean } | { ok: false; message: string }> {
  const prefix = `${userId}/${reviewId}/${token}`;

  const listed = await listFolderFiles(supabase, prefix);
  if (!listed.ok) return { ok: false, message: listed.message };

  for (let i = 0; i < listed.paths.length; i += REMOVE_BATCH_SIZE) {
    const batch = listed.paths.slice(i, i + REMOVE_BATCH_SIZE);
    const { error } = await supabase.storage.from(REVIEW_FILES_BUCKET).remove(batch);
    if (error) return { ok: false, message: error.message };
  }

  const after = await listFolderFiles(supabase, prefix);
  if (!after.ok) return { ok: false, message: after.message };
  return { ok: true, emptied: after.paths.length === 0 };
}

export interface DeadAttemptCleanupResult {
  token: string;
  ok: boolean;
  emptied: boolean;
  message?: string;
}

// Cleanup is "pending" (not done) if any retired folder failed to list/remove or is
// still non-empty. Callers must NOT begin transferring replacement files, nor finish
// the upload, while cleanup is pending -- they retain the attempt and resume cleanup.
export function cleanupPending(results: DeadAttemptCleanupResult[]): boolean {
  return results.some((c) => !c.ok || !c.emptied);
}

// Clean up every CURRENTLY-RECORDED retired attempt folder for a review, each by
// its explicit token. Reminders are NOT removed here (retention is deferred). The
// live op_token is never among these tokens, so the current attempt is never a
// target even if a newer attempt starts while this runs.
export async function cleanupDeadAttempts(
  supabase: SupabaseClient,
  userId: string,
  reviewId: string,
): Promise<DeadAttemptCleanupResult[]> {
  const { data: reminders } = await supabase
    .from("review_dead_upload_attempts")
    .select("token")
    .eq("review_id", reviewId);

  const results: DeadAttemptCleanupResult[] = [];
  for (const r of reminders ?? []) {
    const token = r.token as string;
    const res = await removeAttemptFolder(supabase, userId, reviewId, token);
    results.push(
      res.ok
        ? { token, ok: true, emptied: res.emptied }
        : { token, ok: false, emptied: false, message: res.message },
    );
  }
  return results;
}
