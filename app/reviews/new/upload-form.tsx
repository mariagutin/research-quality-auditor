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

import { useEffect, useMemo, useRef, useState } from "react";
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
import {
  beginUploadAction,
  cleanupRejectedAttemptAction,
  cleanupUploadAction,
  failUploadAction,
  finishSaveAction,
  retryUploadAction,
  touchUploadAction,
} from "../actions";
import type { FinishSaveResult } from "@/lib/reviews/finish-save";

const BUCKET = "review-files";

type Picked = { key: string; file: File; error?: string };
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
  // The review id and its upload lease token come from begin_upload (review-row-
  // first). Both are reused while the attempt resumes, and cleared when the inputs
  // change or the attempt is superseded, so the next save starts a fresh attempt.
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [opToken, setOpToken] = useState<string | null>(null);
  // True once this attempt has CONFIRMED-failed (a PUT error): the next save does a
  // full retry (fresh token + cleanup), not a same-token resume.
  const [needsFullRetry, setNeedsFullRetry] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "editing" });

  const reportInputRef = useRef<HTMLInputElement>(null);
  const addTranscriptRef = useRef<HTMLInputElement>(null);
  // Re-entrancy guard: ignore a second submit while one is already in flight, even
  // during the async window before `busy` becomes true (duplicate-submit prevention).
  const submittingRef = useRef(false);

  const busy = phase.kind === "uploading" || phase.kind === "finishing";

  // Heartbeat: while a long upload/finish is in flight, refresh the lease on a timer
  // so a single slow transfer is not mistaken for a stalled one. The heartbeat is
  // token-fenced server-side, so it only ever renews the current attempt.
  useEffect(() => {
    if (!busy || !reviewId || !opToken) return;
    const id = setInterval(() => {
      void touchUploadAction(reviewId, opToken);
    }, 25_000);
    return () => clearInterval(id);
  }, [busy, reviewId, opToken]);

  // Any change to files or participant ids invalidates a pending attempt, so the
  // next save starts a brand-new one (our "changed inputs = new save" rule).
  function invalidateSave() {
    setReviewId(null);
    setOpToken(null);
    setNeedsFullRetry(false);
    setPhase({ kind: "editing" });
  }

  function onPickReport(file?: File) {
    if (!file) return;
    setReport({ key: crypto.randomUUID(), file, error: validateFile(file) });
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

  // Flag the EXACT file the server rejected, by its stable per-row id (the report or
  // one specific transcript) -- never by filename, which can collide.
  function markRejectedFile(documentId: string) {
    setReport((prev) => (prev && prev.key === documentId ? { ...prev, error: "Replace this file." } : prev));
    setTranscripts((prev) =>
      prev.map((t) => (t.key === documentId ? { ...t, error: "Replace this file." } : t)),
    );
  }

  // A rejected upload must NOT be left as a silently-active 'uploading' review. We
  // fail THIS attempt (fail_review_op is token-fenced: a no-op if another tab already
  // reclaimed the review) so it reads as failed/recoverable, then clean just this
  // attempt's files with the existing attempt-specific sweep -- which targets only
  // {uid}/{reviewId}/{token}/ and never another attempt's folder, so a concurrent
  // reclaim is never clobbered. We do NOT delete the whole review (there is no atomic
  // ownership-confirmed delete); the owner can delete the recoverable draft, and the
  // whole-prefix cleanup backs it on an eventual delete.
  async function handleFileRejected(
    rid: string,
    tok: string,
    result: Extract<FinishSaveResult, { status: "file_rejected" }>,
  ) {
    await failUploadAction(rid, tok);
    await cleanupRejectedAttemptAction(rid, tok);
    markRejectedFile(result.documentId);
    // Replacing the flagged file starts a fresh save (our "changed inputs = new save"
    // rule); the failed attempt stays recoverable until the owner deletes it.
    setReviewId(null);
    setOpToken(null);
    setNeedsFullRetry(false);
    setPhase({ kind: "result", result });
  }

  async function onSave() {
    if (!report) return;
    // Duplicate-submit prevention: ignore a second trigger while one save is still
    // in flight (covers the async window before `busy` becomes true).
    if (submittingRef.current) return;
    submittingRef.current = true;
    try {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        router.push("/login");
        return;
      }

      const files = [
        { role: "report" as const, file: report.file, filename: report.file.name, participantId: null as string | null, clientId: report.key },
        ...transcripts.map((t) => ({
          role: "transcript" as const,
          file: t.file,
          filename: t.file.name,
          participantId: t.participantId.trim(),
          clientId: t.key,
        })),
      ];
      const documents = files.map((f) => ({ role: f.role, filename: f.filename, participantId: f.participantId, clientId: f.clientId }));

      const finish = async (rid: string, tok: string): Promise<FinishSaveResult> => {
        try {
          return await finishSaveAction({ reviewId: rid, opToken: tok, documents });
        } catch {
          return { status: "uncertain", message: "We couldn't confirm your save. Try again to check its status." };
        }
      };

      // --- RESUME after an uncertain outcome: RECONCILE FIRST, before any upload.
      //     If a prior finish actually succeeded (its response was lost), this opens
      //     the existing Draft without re-uploading, marking it failed, or starting
      //     another review. ---
      if (reviewId && opToken && !needsFullRetry) {
        setPhase({ kind: "finishing" });
        const reconciled = await finish(reviewId, opToken);
        if (reconciled.status === "saved") {
          router.push(`/reviews/${reviewId}`);
          return;
        }
        if (reconciled.status === "conflict") {
          setReviewId(null);
          setOpToken(null);
          setNeedsFullRetry(false);
          setPhase({ kind: "result", result: reconciled });
          return;
        }
        if (reconciled.status === "file_rejected") {
          await handleFileRejected(reviewId, opToken, reconciled);
          return;
        }
        // upload_incomplete / uncertain / invalid: fall through to (clean +) re-
        // upload under the SAME attempt. Make sure retired folders are clean first.
        const c = await cleanupUploadAction(reviewId);
        if (!c.ok) {
          setPhase({ kind: "result", result: { status: "uncertain", message: "Finishing cleanup of a previous attempt. Try again." } });
          return;
        }
      }

      // --- Resolve this attempt's token: one-time full retry, fresh begin, or the
      //     same token (resume fall-through). ---
      let rid = reviewId;
      let tok = opToken;
      if (rid && tok && needsFullRetry) {
        const retried = await retryUploadAction(rid);
        if (retried.status === "error") {
          setPhase({ kind: "result", result: { status: "uncertain", message: retried.message } });
          return;
        }
        tok = retried.opToken;
        setOpToken(tok);
        setNeedsFullRetry(false);
        if (retried.status === "cleanup_pending") {
          // The fresh attempt is preserved; do NOT transfer files. The next "Try
          // again" resumes cleanup without creating another attempt.
          setPhase({ kind: "result", result: { status: "uncertain", message: retried.message } });
          return;
        }
      } else if (!rid || !tok) {
        const begun = await beginUploadAction(label ?? "Untitled check");
        if (begun.status !== "started") {
          setPhase({ kind: "result", result: { status: "uncertain", message: begun.message } });
          return;
        }
        rid = begun.reviewId;
        tok = begun.opToken;
        setReviewId(rid);
        setOpToken(tok);
        setNeedsFullRetry(false);
      }
      if (!rid || !tok) {
        setPhase({ kind: "result", result: { status: "uncertain", message: "Couldn't start the upload. Try again." } });
        return;
      }

      // --- Upload under the per-attempt token folder (existing files skipped). ---
      setPhase({ kind: "uploading" });
      for (const f of files) {
        const path = `${user.id}/${rid}/${tok}/${f.filename}`;
        const { error } = await supabase.storage
          .from(BUCKET)
          .upload(path, f.file, { upsert: false, contentType: "text/markdown" });
        if (error && !isAlreadyExists(error.message)) {
          // CONFIRMED upload failure: mark the attempt failed now (immediate
          // recoverability), and require a full retry next time.
          await failUploadAction(rid, tok);
          setNeedsFullRetry(true);
          setPhase({
            kind: "result",
            result: {
              status: "upload_incomplete",
              message: `${f.filename} didn't finish uploading.`,
              missing: [f.filename],
            },
          });
          return; // keep reviewId + selections; "Try again" does a full retry.
        }
      }

      // --- Finish on the server ---
      setPhase({ kind: "finishing" });
      const result = await finish(rid, tok);

      if (result.status === "saved") {
        router.push(`/reviews/${rid}`);
        return;
      }
      if (result.status === "file_rejected") {
        await handleFileRejected(rid, tok, result);
        return;
      }
      if (result.status === "conflict") {
        setReviewId(null);
        setOpToken(null);
        setNeedsFullRetry(false);
      }
      // 'uncertain' / 'upload_incomplete' keep the same attempt so the next "Try
      // again" reconciles (finish-first) and resumes.

      setPhase({ kind: "result", result });
    } finally {
      submittingRef.current = false;
    }
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
            Your report and transcripts contain research data. They are stored in
            private Supabase Storage tied to your account, reachable only by you
            (owner-only access), and are used only to check the quotations in your
            report — the check runs on our server by text comparison and your files
            are not sent to any external AI service. You can delete a check at any
            time, which removes its records and files; if file removal can&apos;t
            finish right away, it completes the next time you open your checks.
            Confirm you understand before uploading.
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
