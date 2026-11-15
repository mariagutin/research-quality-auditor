// Pure decision for the review page's action gating, so the page and its test agree.
//
// The safety property this encodes (finding #4): when the operation status is
// UNAVAILABLE -- the `review_op_active` RPC errored, so we cannot tell whether an
// upload/check/deletion is running -- we must NOT fall through to the permissive
// branch (Delete enabled, Run check shown). We fail safe: assume an operation might
// be active, disable the mutating actions, and surface a retry.

export interface ActionGating {
  /** Show the "A check is running…" notice. */
  showRunningMessage: boolean;
  /** Offer the "Run check" button. */
  showRunCheck: boolean;
  /** Whether Delete should be clickable (it is blocked while an op is ACTIVE, and
   *  while the status is unavailable). */
  deleteEnabled: boolean;
  /** The op status could not be loaded; show an unavailable/retry notice and pause
   *  mutating actions. */
  statusUnavailable: boolean;
}

export function actionGating(args: {
  status: string;
  /** `review_op_active` result; any non-true/unknown value is treated as not-active. */
  opActive: boolean;
  /** The `review_op_active` RPC errored, so activity cannot be determined. */
  opStatusUnavailable: boolean;
}): ActionGating {
  const { status, opActive, opStatusUnavailable } = args;

  if (opStatusUnavailable) {
    return {
      showRunningMessage: false,
      showRunCheck: false,
      deleteEnabled: false,
      statusUnavailable: true,
    };
  }

  const isChecked = status === "complete";
  const isDeleting = status === "deleting";
  const activeProcessing = status === "processing" && opActive;

  return {
    showRunningMessage: activeProcessing,
    showRunCheck: !isChecked && !isDeleting && status !== "uploading" && !activeProcessing,
    deleteEnabled: !opActive,
    statusUnavailable: false,
  };
}
