"use client";

// Per-issue decision control. Three exclusive options. Before the first choice
// nothing is selected. Clicking the already-selected option does nothing;
// switching to another saves it. The confirmation ("Review decision saved: …")
// and the updated selection appear only AFTER storage succeeds (NFR-05), since
// the selection is driven by the value read back from the database.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Alert from "@mui/material/Alert";
import { setDecisionAction } from "../actions";
import { DECISION_VALUES, DECISION_LABELS, decisionSavedMessage, type DecisionValue } from "@/lib/reviews/decisions";

export default function DecisionControl({
  issueId,
  decision,
}: {
  issueId: string;
  decision: DecisionValue | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  function onChange(_e: React.MouseEvent<HTMLElement>, next: DecisionValue | null) {
    // An exclusive ToggleButtonGroup reports `null` when the active option is
    // clicked again -- that is a no-op here (does NOT clear the decision).
    if (next === null) return;

    setError(null);
    setSavedMessage(null);
    startTransition(async () => {
      const result = await setDecisionAction(issueId, next);
      if (result.status === "error") {
        setError(result.message);
        return;
      }
      // Confirm only after the save succeeded, naming the saved choice.
      setSavedMessage(decisionSavedMessage(next));
      router.refresh(); // re-render so the selection + progress come from the DB
    });
  }

  return (
    <Stack spacing={0.5} sx={{ mt: 1 }}>
      <Typography variant="caption" color="text.secondary">
        Decision
      </Typography>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <ToggleButtonGroup
          exclusive
          size="small"
          value={decision}
          onChange={onChange}
          disabled={pending}
          aria-label="Decision for this issue"
        >
          {DECISION_VALUES.map((value) => (
            <ToggleButton key={value} value={value}>
              {DECISION_LABELS[value]}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        {pending && (
          <Typography variant="caption" color="text.secondary">
            Saving…
          </Typography>
        )}
        {!pending && savedMessage && !error && (
          <Typography variant="caption" color="success.main" role="status">
            {savedMessage}
          </Typography>
        )}
      </Stack>
      {error && (
        <Alert severity="error" role="alert" sx={{ py: 0 }}>
          {error}
        </Alert>
      )}
    </Stack>
  );
}
