// Saving a researcher's review decision for one issue. Runs AS the signed-in
// user, so owner-only RLS (and the issue's owner foreign key) decide what is
// allowed. The table keeps at most one decision per issue (UNIQUE issue_id), so
// setting a decision upserts; a decision is switched among the three, never
// cleared.
//
// The DATABASE GUARD (the reject_decision_during_op trigger, migration
// 20261112000000) is the AUTHORITATIVE protection against decision writes while the
// review is busy (uploading/processing/deleting): it refuses the write and raises.
// This module no longer pre-checks the status; it upserts and maps the guard's
// refusal to a friendly message.

import type { SupabaseClient } from "@supabase/supabase-js";

export type DecisionValue = "needs_correction" | "dismiss" | "investigate";

export const DECISION_VALUES: DecisionValue[] = ["needs_correction", "dismiss", "investigate"];

// Plain-language label per decision value, shown on the control and in the
// saved-confirmation message.
export const DECISION_LABELS: Record<DecisionValue, string> = {
  needs_correction: "Needs correction",
  dismiss: "Dismiss",
  investigate: "Investigate",
};

// The confirmation shown ONLY after a save succeeds, naming the saved choice.
export function decisionSavedMessage(decision: DecisionValue): string {
  return `Review decision saved: ${DECISION_LABELS[decision]}`;
}

export type SetDecisionResult =
  | { status: "saved"; decision: DecisionValue }
  | { status: "error"; message: string };

export function isDecisionValue(value: unknown): value is DecisionValue {
  return typeof value === "string" && (DECISION_VALUES as string[]).includes(value);
}

export async function setDecision(
  supabase: SupabaseClient,
  userId: string,
  issueId: string,
  decision: DecisionValue,
): Promise<SetDecisionResult> {
  if (!isDecisionValue(decision)) {
    return { status: "error", message: "That is not a valid decision." };
  }

  // Set or change: one row per issue (UNIQUE issue_id), so upsert on that key. The
  // database guard refuses the write if the review is busy; the owner FK refuses a
  // missing/other-user issue.
  const { error } = await supabase
    .from("review_decisions")
    .upsert({ issue_id: issueId, user_id: userId, decision }, { onConflict: "issue_id" });
  if (!error) return { status: "saved", decision };

  // The guard (reject_decision_during_op) raises P0001 while the review is busy.
  // Read the status to name it in a friendly message.
  if (error.code === "P0001") {
    const { data: issue } = await supabase
      .from("issues")
      .select("review_id")
      .eq("id", issueId)
      .maybeSingle();
    const status = issue
      ? (
          await supabase
            .from("reviews")
            .select("processing_status")
            .eq("id", issue.review_id)
            .maybeSingle()
        ).data?.processing_status
      : null;
    if (status === "deleting") return { status: "error", message: "This check is being deleted." };
    if (status === "processing") return { status: "error", message: "A check is running for this review." };
    if (status === "uploading") return { status: "error", message: "This review is still uploading." };
    return { status: "error", message: "This decision can't be changed right now." };
  }

  // The composite owner foreign key (issue_id, user_id) rejects a missing issue.
  if (error.code === "23503") return { status: "error", message: "That issue no longer exists." };

  return { status: "error", message: "Could not save the decision." };
}
