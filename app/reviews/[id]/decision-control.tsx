"use client";

// Per-issue decision control. Three exclusive options. Before the first choice
// nothing is selected. Clicking the already-selected option does nothing;
// switching to another saves it. The confirmation ("Review decision saved: …")
// and the updated selection appear only AFTER storage succeeds (NFR-05), since
// the selection is driven by the value read back from the database.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Box from "@mui/material/Box";
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
    <Stack spacing={0.75}>
      <Typography variant="subtitle2" fontWeight={700}>
        Decision
      </Typography>
      <ToggleButtonGroup
        exclusive
        value={decision}
        onChange={onChange}
        disabled={pending}
        aria-label="Decision for this issue"
        sx={{
          display: "grid",
          gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
          maxWidth: 460,
          gap: 0.75,
          "& .MuiToggleButtonGroup-grouped": {
            m: 0,
            border: "1px solid #c7ccd2",
            borderRadius: 2,
            minHeight: 44,
            px: 0.5,
            py: 0.5,
            bgcolor: "#F4FBFF",
            color: "#414953",
            textTransform: "none",
            fontSize: "0.8125rem",
            lineHeight: 1.25,
            fontWeight: 700,
            "&:hover": { bgcolor: "#e4e7eb" },
            "&.Mui-selected": {
              bgcolor: "#244c9b",
              color: "#fff",
              borderColor: "#244c9b",
              "&:hover": { bgcolor: "#1e4086" },
            },
            "&.Mui-focusVisible": {
              outline: "2px solid",
              outlineColor: "primary.main",
              outlineOffset: 2,
            },
          },
        }}
      >
        {DECISION_VALUES.map((value) => (
          <ToggleButton key={value} value={value}>
            <span>
              {decision === value && <span aria-hidden="true">✓ </span>}
              {DECISION_LABELS[value]}
            </span>
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
      <Box role="status">
        {pending && (
          <Typography variant="body2" color="text.secondary">
            Saving…
          </Typography>
        )}
        {!pending && savedMessage && !error && (
          <Typography variant="body2" color="success.dark" fontWeight={700}>
            <span aria-hidden="true">✓ </span>{savedMessage}
          </Typography>
        )}
      </Box>
      {error && (
        <Alert severity="error" role="alert" sx={{ py: 0 }}>
          {error}
        </Alert>
      )}
    </Stack>
  );
}
