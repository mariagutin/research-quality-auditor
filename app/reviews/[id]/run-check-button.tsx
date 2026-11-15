"use client";

// Run check button for a saved review. The check runs ONCE, from the pre-check
// state; there is no "Run again" after completion (the page only renders this
// button before the check). Results are stored internally and shown by the page.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Stack from "@mui/material/Stack";
import Button from "@mui/material/Button";
import Alert from "@mui/material/Alert";
import { runCheckAction } from "../actions";
import type { RunCheckResult } from "@/lib/reviews/run-check";

export default function RunCheckButton({ reviewId }: { reviewId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<RunCheckResult | null>(null);

  function onRun() {
    setResult(null);
    startTransition(async () => {
      const r = await runCheckAction(reviewId);
      setResult(r);
      if (r.status === "complete" || r.status === "uncertain") {
        // Refresh so the page reflects the true status: "complete" on success, or
        // the review's current state after an uncertain (unconfirmed) save.
        router.refresh();
      }
    });
  }

  return (
    <Stack spacing={1}>
      <Button
        variant="contained"
        onClick={onRun}
        disabled={pending}
        sx={{ alignSelf: "flex-start" }}
      >
        {pending ? "Running…" : "Run check"}
      </Button>
      {result?.status === "complete" && (
        <Alert severity="success" role="status">
          Check complete.
        </Alert>
      )}
      {result?.status === "error" && (
        <Alert severity="error" role="alert">
          {result.message}
        </Alert>
      )}
      {result?.status === "uncertain" && (
        // NOT a confirmed failure: the save outcome is unknown. Warning, not error.
        <Alert severity="warning" role="status">
          {result.message}
        </Alert>
      )}
    </Stack>
  );
}
