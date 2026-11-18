// A saved check. Server component: loads the review and its documents AS the
// signed-in user (owner-only RLS means a stranger's id simply returns nothing),
// and shows the saved label, its status, the file list, and -- once checked --
// the quotations that have an issue, in report order, with a summary.

import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import Box from "@mui/material/Box";
import GlobalStyles from "@mui/material/GlobalStyles";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Chip from "@mui/material/Chip";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import Button from "@mui/material/Button";
import Divider from "@mui/material/Divider";
import Alert from "@mui/material/Alert";
import { createClient } from "@/lib/supabase/server";
import RunCheckButton from "./run-check-button";
import { buildIssuesView, resultState, type DecisionRow } from "@/lib/reviews/issues-view";
import { actionGating } from "@/lib/reviews/action-gating";
import ReviewIssues from "./review-issues";
import DeleteReviewButton from "./delete-review-button";
import BusyRefresh from "./busy-refresh";
import RetryStatus from "./retry-status";

export default async function ReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: review } = await supabase
    .from("reviews")
    .select("id, name, processing_status")
    .eq("id", id)
    .maybeSingle();
  if (!review) notFound();

  const { data: documents } = await supabase
    .from("documents")
    .select("id, role, filename, participant_id")
    .eq("review_id", id)
    .order("role", { ascending: true })
    .order("filename", { ascending: true });

  const isPreCheck = review.processing_status === "draft";
  const isChecked = review.processing_status === "complete";
  const isDeleting = review.processing_status === "deleting";

  // Is the review's current operation ACTIVE (vs. a recoverable failed/stale one)?
  // Computed with DATABASE time, so Delete/Retry gating reflects recoverability. If
  // the RPC errors we must NOT assume "not active" (that would permissively enable
  // Delete / Run check during a live op) -- `actionGating` fails safe on the error.
  const { data: opActive, error: opActiveError } = await supabase.rpc("review_op_active", { p_review_id: id });
  const gate = actionGating({
    status: review.processing_status,
    opActive: opActive === true,
    opStatusUnavailable: !!opActiveError,
  });

  // Only a completed check has results to show.
  let issuesView = null;
  if (isChecked) {
    const [{ data: quotations }, { data: issues }] = await Promise.all([
      supabase
        .from("quotations")
        .select("id, original_text, listed_participant_id, start_offset, checking_result")
        .eq("review_id", id),
      supabase
        .from("issues")
        .select("id, quotation_id, issue_type, explanation, source_document_id, source_excerpt")
        .eq("review_id", id),
    ]);
    const issueIds = (issues ?? []).map((i) => i.id);
    const { data: decisions } = issueIds.length
      ? await supabase.from("review_decisions").select("issue_id, decision").in("issue_id", issueIds)
      : { data: [] };
    issuesView = buildIssuesView({
      quotations: quotations ?? [],
      issues: issues ?? [],
      documents: (documents ?? []).map((d) => ({ id: d.id, filename: d.filename, participantId: d.participant_id })),
      decisions: (decisions ?? []) as DecisionRow[],
    });
  }


  const isBusy =
    review.processing_status === "uploading" ||
    review.processing_status === "processing" ||
    review.processing_status === "deleting";

  const reviewFiles = (
    <List dense disablePadding>
      {(documents ?? []).map((doc) => (
        <ListItem key={doc.id} disableGutters>
          <ListItemText
            sx={{ overflowWrap: "anywhere" }}
            primary={doc.filename}
            secondary={doc.role === "transcript" ? `transcript · ${doc.participant_id ?? "—"}` : "report"}
          />
        </ListItem>
      ))}
    </List>
  );

  return (
    <Box sx={{ bgcolor: isChecked ? "background.paper" : undefined, minHeight: isChecked ? "100vh" : undefined }}>
      {isChecked && (
        <Box component="header" sx={{ bgcolor: "#f5f6f8", borderBottom: 1, borderColor: "#eaedf0" }}>
          <GlobalStyles
            styles={{
              "@font-face": {
                fontFamily: "IBM Plex Sans",
                src: 'url("/fonts/ibm-plex-sans-latin-600-normal.woff2") format("woff2")',
                fontStyle: "normal",
                fontWeight: 600,
                fontDisplay: "swap",
              },
            }}
          />
          <Box sx={{ display: "flex", alignItems: "center", maxWidth: 1120, minHeight: 48, mx: "auto", px: { xs: 2, sm: 3 }, py: 0.75 }}>
            <Typography
              variant="subtitle2"
              fontWeight={600}
              sx={{
                color: "#203550",
                fontFamily: '"IBM Plex Sans", Arial, sans-serif',
                fontSize: { xs: "1rem", sm: "1.125rem" },
                lineHeight: 1.2,
              }}
            >
              Research Quality Auditor
            </Typography>
          </Box>
        </Box>
      )}
      <Box component="main" sx={{ maxWidth: isChecked ? 1120 : 640, mx: "auto", p: { xs: 2, sm: 3 } }}>
        {/* While busy, re-fetch the DB-time op state so recovery controls appear after
            an interruption (and completion is picked up) without a manual reload. */}
        {isBusy && <BusyRefresh />}
        <Stack spacing={2}>
          <Stack direction="row" gap={1.5} alignItems="center" justifyContent={isChecked ? "space-between" : undefined}>
            <Typography
              variant="h4"
              component="h1"
              sx={{
                fontWeight: isChecked ? 700 : undefined,
                fontSize: isChecked ? { xs: "1.375rem", sm: "1.625rem" } : undefined,
                overflowWrap: "anywhere",
                minWidth: 0,
              }}
            >
              {review.name}
            </Typography>
            <Chip
              label={
                isPreCheck
                  ? "Saved · pre-check"
                  : isChecked
                    ? "Check complete"
                    : isDeleting
                      ? "Deletion in progress"
                      : review.processing_status
              }
              color={isPreCheck || isChecked ? "default" : "primary"}
              sx={isChecked ? { bgcolor: "grey.100", color: "text.secondary", fontWeight: 700 } : undefined}
              size="small"
            />
          </Stack>

          {isPreCheck && (
            <Typography variant="body2" color="text.secondary">
              Saved. Run the quotation check below.
            </Typography>
          )}

          {isDeleting && (
            <Typography variant="body2" color="text.secondary">
              This check is being deleted. Other actions are paused until it finishes.
            </Typography>
          )}

          {gate.showRunningMessage && (
            <Typography variant="body2" color="text.secondary">
              A check is running for this review…
            </Typography>
          )}

          {gate.statusUnavailable && (
            <Alert severity="warning" role="status" action={<RetryStatus />}>
              We couldn&apos;t load this review&apos;s current status. Actions are paused until it loads — retry.
            </Alert>
          )}

          {/* The check runs once, from the pre-check state (and may be re-run for a
              recoverable failed/stale check). It is hidden while a check is actively
              running, while deleting, while uploading, or while the op status can't be
              loaded (fail-safe -- see actionGating). */}
          {gate.showRunCheck && <RunCheckButton reviewId={id} />}

          {issuesView && (
            <>
              {issuesView.quotationsChecked > 0 && (
                <Typography variant="body2" color="text.secondary">
                  {`Checked ${issuesView.quotationsChecked} quotation${
                    issuesView.quotationsChecked === 1 ? "" : "s"
                  } · ${issuesView.totalIssues} issue${
                    issuesView.totalIssues === 1 ? "" : "s"
                  } found`}
                </Typography>
              )}

              {resultState(issuesView) === "no_quotations" ? (
                <Alert severity="info" role="status">
                  No quotations found to check. No text in double quotation marks was found in the report.
                </Alert>
              ) : resultState(issuesView) === "no_issues" ? (
                <Alert severity="success" role="status">
                  No issues found. Every quotation matched a participant&apos;s transcript.
                </Alert>
              ) : (
                <ReviewIssues view={issuesView} />
              )}
            </>
          )}

          <Divider />
          {isChecked ? (
            <Box component="details">
              <Typography
                component="summary"
                variant="subtitle1"
                sx={{ cursor: "pointer", fontWeight: 700, py: 1, minHeight: 44 }}
              >
                Files in this check ({documents?.length ?? 0})
              </Typography>
              {reviewFiles}
            </Box>
          ) : (
            <>
              <Typography variant="h6" component="h2">Files in this check</Typography>
              {reviewFiles}
            </>
          )}

          <Divider />
          <DeleteReviewButton
            reviewId={id}
            status={review.processing_status}
            opActive={opActive === true}
            statusUnavailable={gate.statusUnavailable}
          />

          <Box>
            <Button component={Link} href="/reviews/new" variant="outlined" size="small">
              Start another check
            </Button>
          </Box>
        </Stack>
      </Box>
    </Box>
  );
}
