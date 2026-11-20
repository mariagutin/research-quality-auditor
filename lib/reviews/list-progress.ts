// Loads the review-progress counts for the "Your checks" page.
//
// Runs AS THE SIGNED-IN USER (owner-only RLS is the enforcing boundary, ADR-0003);
// the explicit `user_id` filter also keeps each request small, so no long list of
// review ids is sent in a URL. Each list is read in full with `fetchAllRows`, so
// the API's per-request row limit can't silently cut rows off and skew a status.
//
// Returns `null` if any list can't be read completely; the page then shows
// "Review status unavailable" instead of a status that might be wrong.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  countReviewProgress,
  fetchAllRows,
  type IssueCountRow,
  type QuotationCountRow,
  type ReviewCounts,
} from "./list-status";

export async function loadReviewProgress(
  supabase: SupabaseClient,
  userId: string,
  reviewIds: string[],
): Promise<Map<string, ReviewCounts> | null> {
  if (reviewIds.length === 0) return new Map();

  try {
    const [quotations, issues, decisions] = await Promise.all([
      fetchAllRows<QuotationCountRow>((from, to) =>
        supabase
          .from("quotations")
          .select("id, review_id, checking_result", { count: "exact" })
          .eq("user_id", userId)
          .order("id")
          .range(from, to),
      ),
      fetchAllRows<IssueCountRow>((from, to) =>
        supabase
          .from("issues")
          .select("id, review_id, quotation_id", { count: "exact" })
          .eq("user_id", userId)
          .order("id")
          .range(from, to),
      ),
      fetchAllRows<{ issue_id: string }>((from, to) =>
        supabase
          .from("review_decisions")
          .select("issue_id", { count: "exact" })
          .eq("user_id", userId)
          .order("id")
          .range(from, to),
      ),
    ]);
    if (!quotations || !issues || !decisions) return null;

    return countReviewProgress({
      reviewIds,
      quotations,
      issues,
      decidedIssueIds: decisions.map((d) => d.issue_id),
    });
  } catch {
    return null;
  }
}
