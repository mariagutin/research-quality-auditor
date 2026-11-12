// Saving a researcher's review decision for one issue. Runs AS the signed-in
// user, so owner-only RLS (and the issue's owner foreign key) decide what is
// allowed. The table keeps at most one decision per issue (UNIQUE issue_id), so
// setting a decision upserts; a decision is switched among the three, never
// cleared.

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

  // Set or change: one row per issue (UNIQUE issue_id), so upsert on that key.
  const { error } = await supabase
    .from("review_decisions")
    .upsert({ issue_id: issueId, user_id: userId, decision }, { onConflict: "issue_id" });
  if (error) return { status: "error", message: "Could not save the decision." };
  return { status: "saved", decision };
}
