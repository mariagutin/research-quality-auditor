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
