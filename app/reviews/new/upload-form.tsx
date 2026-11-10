"use client";

// The upload screen. Anna acknowledges data handling, picks one report + one or
// more transcripts (.md), confirms each transcript's participant id, then saves.
//
// Save orchestration (per our design):
//   - Files upload directly to the private review-files bucket under
//     {userId}/{reviewId}/{filename}; the server action then FINISHES the save
//     (verifies files + contents, creates the records atomically).
//   - The reviewId is minted once and REUSED while the files and participant ids
//     are unchanged (so a timeout / interrupted-upload retry resumes the same
//     save). ANY change to the files or ids clears it, so the next save starts
//     fresh -- which is what replacing a rejected file does.
//   - Selections always stay on screen; only success navigates away.

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import FormControlLabel from "@mui/material/FormControlLabel";
import Checkbox from "@mui/material/Checkbox";
import Button from "@mui/material/Button";
import TextField from "@mui/material/TextField";
import Alert from "@mui/material/Alert";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import LinearProgress from "@mui/material/LinearProgress";
import { createClient } from "@/lib/supabase/client";
import { finishSaveAction } from "../actions";
import type { FinishSaveResult } from "@/lib/reviews/finish-save";

const BUCKET = "review-files";

type Picked = { file: File; error?: string };
type Transcript = { key: string; file: File; participantId: string; error?: string };

type Phase =
  | { kind: "editing" }
  | { kind: "uploading" }
  | { kind: "finishing" }
  | { kind: "result"; result: FinishSaveResult };

function validateFile(file: File): string | undefined {
  if (!/\.md$/i.test(file.name)) return "Must be a .md file.";
  if (file.size === 0) return "This file is empty.";
  return undefined;
}

function labelFromReport(filename: string): string {
  return filename.replace(/\.md$/i, "").trim() || filename.trim() || "Untitled check";
}

function isAlreadyExists(message: string): boolean {
  return /(already exists|duplicate|resource already)/i.test(message);
}

export default function UploadForm() {
  const router = useRouter();

  const [acknowledged, setAcknowledged] = useState(false);
  const [report, setReport] = useState<Picked | null>(null);
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "editing" });

  const reportInputRef = useRef<HTMLInputElement>(null);
  const addTranscriptRef = useRef<HTMLInputElement>(null);

  const busy = phase.kind === "uploading" || phase.kind === "finishing";

  // Any change to files or participant ids invalidates a pending reviewId, so
  // the next save starts a brand-new one (our "changed inputs = new save" rule).
  function invalidateSave() {
    setReviewId(null);
    setPhase({ kind: "editing" });
  }

  function onPickReport(file?: File) {
    if (!file) return;
    setReport({ file, error: validateFile(file) });
    invalidateSave();
  }

  function onAddTranscript(file?: File) {
    if (!file) return;
    setTranscripts((prev) => [
      ...prev,
      { key: crypto.randomUUID(), file, participantId: "", error: validateFile(file) },
    ]);
    invalidateSave();
  }

  function onReplaceTranscript(key: string, file?: File) {
    if (!file) return;
    setTranscripts((prev) =>
      prev.map((t) => (t.key === key ? { ...t, file, error: validateFile(file) } : t)),
    );
    invalidateSave();
  }

  function onRemoveTranscript(key: string) {
    setTranscripts((prev) => prev.filter((t) => t.key !== key));
    invalidateSave();
  }

  function onChangeParticipant(key: string, value: string) {
    setTranscripts((prev) => prev.map((t) => (t.key === key ? { ...t, participantId: value } : t)));
    invalidateSave();
  }

  const label = report ? labelFromReport(report.file.name) : null;

  const canSave = useMemo(() => {
    if (!acknowledged || !report || report.error) return false;
    if (transcripts.length < 1) return false;
    return transcripts.every((t) => !t.error && t.participantId.trim().length > 0);
  }, [acknowledged, report, transcripts]);

  async function onSave() {
    if (!report) return;

    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      router.push("/login");
      return;
    }

    const rid = reviewId ?? crypto.randomUUID();
    setReviewId(rid);

    const files = [
      { role: "report" as const, file: report.file, filename: report.file.name, participantId: null as string | null },
      ...transcripts.map((t) => ({
        role: "transcript" as const,
        file: t.file,
        filename: t.file.name,
        participantId: t.participantId.trim(),
      })),
    ];

    // --- Upload (direct to Storage). Re-uploading an existing file on retry is
    //     a no-op we ignore, so only missing files actually transfer. ---
    setPhase({ kind: "uploading" });
    for (const f of files) {
      const path = `${user.id}/${rid}/${f.filename}`;
      const { error } = await supabase.storage
        .from(BUCKET)
        .upload(path, f.file, { upsert: false, contentType: "text/markdown" });
      if (error && !isAlreadyExists(error.message)) {
        setPhase({
          kind: "result",
          result: {
            status: "upload_incomplete",
            message: `${f.filename} didn't finish uploading.`,
            missing: [f.filename],
          },
        });
        return; // keep reviewId + selections so "Try again" resumes.
      }
    }

    // --- Finish on the server ---
    setPhase({ kind: "finishing" });
    let result: FinishSaveResult;
    try {
      result = await finishSaveAction({
        reviewId: rid,
        documents: files.map((f) => ({
          role: f.role,
          filename: f.filename,
          participantId: f.participantId,
        })),
      });
    } catch {
      result = {
        status: "uncertain",
        message: "We couldn't confirm your save. Try again to check its status.",
      };
    }

    if (result.status === "saved") {
      router.push(`/reviews/${rid}`);
      return;
    }

    // A rejected file, or a genuine conflict, means the next save is a NEW one.
    if (result.status === "file_rejected") {
      setTranscripts((prev) =>
        prev.map((t) => (t.file.name === result.filename ? { ...t, error: "Replace this file." } : t)),
      );
      setReviewId(null);
    }
    if (result.status === "conflict") {
      setReviewId(null);
    }

    setPhase({ kind: "result", result });
  }

  const result = phase.kind === "result" ? phase.result : null;

  return (
    <Box sx={{ maxWidth: 560, mx: "auto", p: 3 }}>
      <Stack spacing={2.5}>
        <Typography variant="h4" component="h1">
          Start a new check
        </Typography>

        {/* Acknowledgment gate */}
        <Box>
          <Typography variant="body2" color="text.secondary" gutterBottom>
            Your report and transcripts contain research data. They are uploaded to
            your own private storage, visible only to you, and are used only to check
            the quotations in your report. Confirm you understand before uploading.
          </Typography>
          <FormControlLabel
            control={
              <Checkbox
                checked={acknowledged}
                disabled={busy}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
            }
            label="I understand how my research data is handled"
          />
        </Box>

        {/* The upload form appears only after Anna acknowledges data handling,
            and disappears again if she unchecks it (which also blocks saving).
            Her selections are preserved in state while hidden. */}
        {acknowledged && (
          <>
            <Divider />

            {/* Report */}
        <Box>
          <Typography variant="subtitle1" component="h2" gutterBottom>
            Report
          </Typography>
          <input
            ref={reportInputRef}
            type="file"
            accept=".md"
            hidden
            onChange={(e) => onPickReport(e.target.files?.[0])}
          />
          {report ? (
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
              <Typography variant="body2">{report.file.name}</Typography>
              <Button size="small" disabled={busy} onClick={() => reportInputRef.current?.click()}>
                Replace
              </Button>
              {report.error && (
                <Typography variant="caption" color="error">
                  {report.error}
                </Typography>
              )}
            </Stack>
          ) : (
            <Button
              variant="outlined"
              disabled={busy}
              onClick={() => reportInputRef.current?.click()}
            >
              Choose report (.md)
            </Button>
          )}
        </Box>

        {/* Transcripts */}
        <Box>
          <Typography variant="subtitle1" component="h2" gutterBottom>
            Transcripts
          </Typography>
          <Stack spacing={1.5}>
            {transcripts.map((t) => (
              <Box key={t.key}>
                <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                  <Typography variant="body2" sx={{ minWidth: 120 }}>
                    {t.file.name}
                  </Typography>
                  <TextField
                    label="Participant ID"
                    placeholder="e.g. P03"
                    size="small"
                    value={t.participantId}
                    disabled={busy}
                    onChange={(e) => onChangeParticipant(t.key, e.target.value)}
                    sx={{ width: 160 }}
                  />
                  <ReplaceButton
                    disabled={busy}
                    onFile={(file) => onReplaceTranscript(t.key, file)}
                  />
                  <IconButton
                    aria-label={`Remove ${t.file.name}`}
                    size="small"
                    disabled={busy}
                    onClick={() => onRemoveTranscript(t.key)}
                  >
                    ✕
                  </IconButton>
                </Stack>
                {t.error && (
                  <Typography variant="caption" color="error">
                    {t.error}
                  </Typography>
                )}
              </Box>
            ))}
          </Stack>

          <input
            ref={addTranscriptRef}
            type="file"
            accept=".md"
            hidden
            onChange={(e) => {
              onAddTranscript(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <Button
            sx={{ mt: 1 }}
            size="small"
            disabled={busy}
            onClick={() => addTranscriptRef.current?.click()}
          >
            + Add transcript
          </Button>
        </Box>

        {label && (
          <Typography variant="body2" color="text.secondary">
            This check will be saved as <strong>&ldquo;{label}&rdquo;</strong>.
          </Typography>
        )}

        {busy && (
          <Box>
            <LinearProgress />
            <Typography variant="caption" color="text.secondary">
              {phase.kind === "uploading" ? "Uploading files…" : "Finishing & checking your files…"}
            </Typography>
          </Box>
        )}

        {result && <ResultBanner result={result} onRetry={onSave} />}

            <Button variant="contained" disabled={!canSave || busy} onClick={onSave}>
              Save check
            </Button>
          </>
        )}
      </Stack>
    </Box>
  );
}

// A small "Replace" control backed by its own hidden file input.
function ReplaceButton({
  disabled,
  onFile,
}: {
  disabled?: boolean;
  onFile: (file?: File) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept=".md"
        hidden
        onChange={(e) => {
          onFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <Button size="small" disabled={disabled} onClick={() => ref.current?.click()}>
        Replace
      </Button>
    </>
  );
}

function ResultBanner({
  result,
  onRetry,
}: {
  result: FinishSaveResult;
  onRetry: () => void;
}) {
  // Interrupted upload or uncertain outcome -> resume the SAME save with Try again.
  if (result.status === "upload_incomplete" || result.status === "uncertain") {
    return (
      <Alert
        severity={result.status === "uncertain" ? "warning" : "info"}
        action={
          <Button color="inherit" size="small" onClick={onRetry}>
            Try again
          </Button>
        }
      >
        {result.message}
      </Alert>
    );
  }

  // Rejected file or conflict -> Anna must change something; it becomes a new save.
  if (result.status === "file_rejected") {
    return <Alert severity="error">{result.message} Replace the file (or correct the ID), then save again.</Alert>;
  }
  if (result.status === "conflict") {
    return <Alert severity="warning">{result.message} Save again to start a fresh check.</Alert>;
  }
  if (result.status === "invalid") {
    return <Alert severity="error">{result.message}</Alert>;
  }
  return null; // "saved" navigates away, so it is never shown here.
}
