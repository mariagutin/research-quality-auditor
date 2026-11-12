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
