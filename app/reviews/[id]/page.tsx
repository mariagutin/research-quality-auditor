// A saved check. Server component: loads the review and its documents AS the
// signed-in user (owner-only RLS means a stranger's id simply returns nothing),
// and shows the saved label, its status, the file list, and -- once checked --
// the quotations that have an issue, in report order, with a summary.

import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import Box from "@mui/material/Box";
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
import { buildIssuesView, type DecisionRow } from "@/lib/reviews/issues-view";
import type { DiffSeg } from "@/lib/reviews/text-compare";
import DecisionControl from "./decision-control";

// A passage rendered verbatim, with differing words highlighted.
function HighlightedPassage({ segments }: { segments: DiffSeg[] }) {
  return (
    <Typography variant="body2" component="p" sx={{ fontFamily: "monospace", whiteSpace: "pre-wrap", m: 0 }}>
      {segments.map((seg, i) =>
        seg.changed ? (
          <Box
            key={i}
            component="span"
            sx={{ bgcolor: "warning.light", color: "warning.contrastText", fontWeight: 700, borderRadius: 0.5, px: 0.25 }}
          >
            {seg.text}
          </Box>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </Typography>
  );
}

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


  return (
    <Box sx={{ maxWidth: 640, mx: "auto", p: 3 }}>
      <Stack spacing={2}>
        <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap">
          <Typography variant="h4" component="h1">
            {review.name}
          </Typography>
          <Chip
            label={
              isPreCheck
                ? "Saved · pre-check"
                : isChecked
                  ? "Checked"
                  : review.processing_status
            }
            color={isPreCheck ? "default" : "primary"}
            size="small"
          />
        </Stack>

        {isPreCheck && (
          <Typography variant="body2" color="text.secondary">
            Saved. Run the quotation check below.
          </Typography>
        )}

        {/* The check runs once, from the pre-check state. There is no "Run again"
            after completion, so reviewing never regenerates issues or decisions. */}
        {!isChecked && <RunCheckButton reviewId={id} />}

        {issuesView && (
          <>
            <Divider />
            <Typography variant="h6" component="h2">
              Results
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {`Checked ${issuesView.quotationsChecked} quotation${
                issuesView.quotationsChecked === 1 ? "" : "s"
              } · ${issuesView.totalIssues} issue${
                issuesView.totalIssues === 1 ? "" : "s"
              } found`}
            </Typography>

            {issuesView.totalIssues > 0 && (
              <Typography variant="body2" color="text.secondary">
                {issuesView.reviewedCount === issuesView.totalIssues
                  ? `All ${issuesView.totalIssues} issue${issuesView.totalIssues === 1 ? "" : "s"} reviewed. Your decisions are saved.`
                  : `${issuesView.reviewedCount} of ${issuesView.totalIssues} issue${issuesView.totalIssues === 1 ? "" : "s"} reviewed`}
              </Typography>
            )}

            {issuesView.entries.length === 0 ? (
              <Alert severity="success" role="status">
                No issues found. Every quotation matched a participant&apos;s transcript.
              </Alert>
            ) : (
              <Stack spacing={2.5} component="ol" sx={{ listStyle: "none", m: 0, p: 0 }}>
                {issuesView.entries.map((entry) => (
                  <Box key={`${entry.quotationId}-${entry.issueIndex}`} component="li">
                    {entry.issueCount > 1 && (
                      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 0.25 }}>
                        Issue {entry.issueIndex} of {entry.issueCount} for this quotation
                      </Typography>
                    )}
                    <Typography variant="body1" sx={{ fontStyle: "italic" }}>
                      &ldquo;{entry.quote}&rdquo;
                    </Typography>

                    <Box sx={{ mt: 0.75 }}>
                      <Chip
                        label={entry.label.label}
                        size="small"
                        color={
                          entry.label.kind === "participant_mismatch"
                            ? "warning"
                            : entry.label.kind === "wording_mismatch"
                              ? "info"
                              : "default"
                        }
                      />
                    </Box>

                    {entry.note && (
                      <Typography variant="body2" sx={{ mt: 0.5 }}>
                        {entry.note}
                      </Typography>
                    )}

                    {entry.evidence?.kind === "plain" && (
                      <Box sx={{ mt: 1, bgcolor: "action.hover", borderRadius: 1, px: 1.5, py: 1 }}>
                        <Typography variant="caption" color="text.secondary">
                          {entry.evidence.filename}
                        </Typography>
                        <Typography variant="body2" sx={{ fontFamily: "monospace", whiteSpace: "pre-wrap" }}>
                          {entry.evidence.excerpt}
                        </Typography>
                      </Box>
                    )}

                    {entry.evidence?.kind === "diff" && (
                      <Box sx={{ mt: 1, bgcolor: "action.hover", borderRadius: 1, px: 1.5, py: 1 }}>
                        <Typography variant="caption" color="text.secondary">
                          Report
                        </Typography>
                        <HighlightedPassage segments={entry.evidence.report} />
                        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1 }}>
                          {entry.evidence.filename}
                          {entry.evidence.participantId ? ` · ${entry.evidence.participantId}` : ""} · verbatim
                        </Typography>
                        <HighlightedPassage segments={entry.evidence.transcript} />
                      </Box>
                    )}

                    <DecisionControl issueId={entry.issueId} decision={entry.decision} />
                  </Box>
                ))}
              </Stack>
            )}
          </>
        )}

        <Divider />
        <Typography variant="h6" component="h2">
          Files in this check
        </Typography>
        <List dense disablePadding>
          {(documents ?? []).map((doc) => (
            <ListItem key={doc.filename} disableGutters>
              <ListItemText
                primary={doc.filename}
                secondary={
                  doc.role === "transcript"
                    ? `transcript · ${doc.participant_id ?? "—"}`
                    : "report"
                }
              />
            </ListItem>
          ))}
        </List>

        <Box>
          <Button component={Link} href="/reviews/new" variant="outlined" size="small">
            Start another check
          </Button>
        </Box>
      </Stack>
    </Box>
  );
}
