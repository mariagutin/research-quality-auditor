"use client";

// Run check button for a saved review. Calls the server action, shows progress,
// and on success shows "Check complete." Match results and evidence are stored
// internally and are deliberately NOT shown here.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Stack from "@mui/material/Stack";
import Button from "@mui/material/Button";
import Alert from "@mui/material/Alert";
import { runCheckAction } from "../actions";
import type { RunCheckResult } from "@/lib/reviews/run-check";

export default function RunCheckButton({
  reviewId,
  status,
}: {
  reviewId: string;
  status: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<RunCheckResult | null>(null);

  const alreadyChecked = status === "complete";

  function onRun() {
    setResult(null);
    startTransition(async () => {
      const r = await runCheckAction(reviewId);
      setResult(r);
      if (r.status === "complete") {
        router.refresh(); // re-render the page so the status reflects "complete"
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
        {pending ? "Running…" : alreadyChecked ? "Run again" : "Run check"}
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
    </Stack>
  );
}
