"use client";

// Delete control for a saved check. Behaviour:
//   * draft / complete / failed -> "Delete this check" opens a confirmation.
//   * processing / uploading (an ACTIVE operation) -> disabled, with a reason.
//   * deleting -> "Deletion in progress" + "Retry delete" (for a failed or
//     interrupted deletion; database-time recovery lets a stale one be reclaimed).
// Results: a clean delete returns to the list; a delete whose FILE cleanup is still
// pending shows an accurate message (it does NOT claim all files were removed); a
// block/error stays put with a message so the owner can retry.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import Alert from "@mui/material/Alert";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogActions from "@mui/material/DialogActions";
import { deleteReviewAction } from "../actions";
import type { DeleteReviewResult } from "@/lib/reviews/delete-review";

function ResultAlert({ result }: { result: DeleteReviewResult }) {
  if (result.status === "deleted" && result.cleanupPending) {
    return (
      <Alert
        severity="warning"
        role="status"
        action={
          <Button component={Link} href="/reviews" color="inherit" size="small">
            Your checks
          </Button>
        }
      >
        The check was deleted. Its files are still being removed and will finish on your next visit.
      </Alert>
    );
  }
  if (result.status === "blocked") return <Alert severity="info" role="status">{result.message}</Alert>;
  if (result.status === "not_found") return <Alert severity="info" role="status">{result.message}</Alert>;
  if (result.status === "error") return <Alert severity="error" role="alert">{result.message}</Alert>;
  return null; // a clean delete navigates away, so nothing is shown here.
}

export default function DeleteReviewButton({
  reviewId,
  status,
  opActive,
  statusUnavailable = false,
}: {
  reviewId: string;
  status: string;
  // Whether the review's current operation is ACTIVE (busy, not confirmed-failed,
  // not stale) -- computed server-side with DATABASE time. A recoverable (failed or
  // stale) operation is NOT active, so Delete/Retry are enabled appropriately.
  opActive: boolean;
  // The op status couldn't be loaded (review_op_active errored). Fail-safe: disable
  // Delete/Retry rather than risk acting during an operation we can't see.
  statusUnavailable?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<DeleteReviewResult | null>(null);

  const isDeleting = status === "deleting";
  // Delete is blocked ONLY while an upload/check is ACTIVE. A stale or confirmed-
  // failed one is recoverable -> Delete is enabled and will reclaim + clean it up.
  const deleteBlockedByActive = (status === "processing" || status === "uploading") && opActive;
  const interruptedBusy = (status === "processing" || status === "uploading") && !opActive;

  function run() {
    setResult(null);
    startTransition(async () => {
      const r = await deleteReviewAction(reviewId);
      setResult(r);
      if ((r.status === "deleted" && !r.cleanupPending) || r.status === "not_found") {
        router.push("/reviews"); // gone -> back to the list
      }
      // deleted+cleanupPending / blocked / error: stay and show the message.
    });
  }

  if (isDeleting) {
    // Retry is enabled only once the deletion has FAILED or STALLED (recoverable);
    // it is disabled while an active deletion is still in progress.
    const deletionActive = opActive;
    return (
      <Stack spacing={1} sx={{ mt: 1 }}>
        <Stack direction="row" spacing={1} alignItems="center">
          {deletionActive && <CircularProgress size={16} />}
          <Typography variant="body2" color="text.secondary">
            {deletionActive ? "Deletion in progress" : "Deletion interrupted"}
          </Typography>
        </Stack>
        <Button
          color="error"
          variant="outlined"
          size="small"
          onClick={run}
          disabled={pending || deletionActive || statusUnavailable}
          sx={{ alignSelf: "flex-start" }}
        >
          {pending ? "Retrying…" : "Retry delete"}
        </Button>
        {deletionActive && (
          <Typography variant="caption" color="text.secondary">
            Retry becomes available if the deletion stalls.
          </Typography>
        )}
        {result && <ResultAlert result={result} />}
      </Stack>
    );
  }

  return (
    <Stack spacing={1} sx={{ mt: 1 }}>
      <Button
        color="error"
        variant="outlined"
        size="small"
        onClick={() => setOpen(true)}
        disabled={pending || deleteBlockedByActive || statusUnavailable}
        sx={{ alignSelf: "flex-start" }}
      >
        {pending ? "Deleting…" : "Delete this check"}
      </Button>
      {statusUnavailable && !deleteBlockedByActive && (
        <Typography variant="caption" color="text.secondary">
          Delete is paused until this review&apos;s status loads.
        </Typography>
      )}
      {deleteBlockedByActive && (
        <Typography variant="caption" color="text.secondary">
          {status === "processing"
            ? "You can delete this once the check finishes."
            : "You can delete this once the upload finishes."}
        </Typography>
      )}
      {interruptedBusy && (
        <Typography variant="caption" color="text.secondary">
          This {status === "processing" ? "check" : "upload"} was interrupted. Deleting will clean it up.
        </Typography>
      )}
      {result && <ResultAlert result={result} />}

      <Dialog open={open} onClose={() => setOpen(false)}>
        <DialogTitle>Delete this check?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This permanently deletes the check, its results and decisions, and its uploaded files. This can&apos;t be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            color="error"
            onClick={() => {
              setOpen(false);
              run();
            }}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
