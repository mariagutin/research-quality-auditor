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
import { buildIssuesView } from "@/lib/reviews/issues-view";

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
        .select("quotation_id, issue_type, explanation, source_document_id, source_excerpt")
        .eq("review_id", id),
    ]);
    issuesView = buildIssuesView({
      quotations: quotations ?? [],
      issues: issues ?? [],
      documents: (documents ?? []).map((d) => ({ id: d.id, filename: d.filename })),
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

        <RunCheckButton reviewId={id} status={review.processing_status} />

        {issuesView && (
          <>
            <Divider />
            <Typography variant="h6" component="h2">
              Results
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {`Checked ${issuesView.totalChecked} quotation${
                issuesView.totalChecked === 1 ? "" : "s"
              } · ${issuesView.totalWithIssues} with issue${
                issuesView.totalWithIssues === 1 ? "" : "s"
              }`}
            </Typography>

            {issuesView.items.length === 0 ? (
              <Alert severity="success" role="status">
                No issues found. Every quotation matched a participant&apos;s transcript.
              </Alert>
            ) : (
              <Stack spacing={2} component="ol" sx={{ listStyle: "none", m: 0, p: 0 }}>
                {issuesView.items.map((item) => (
                  <Box key={item.quotationId} component="li">
                    <Typography variant="body1" sx={{ fontStyle: "italic" }}>
                      &ldquo;{item.quote}&rdquo;
                    </Typography>
                    {item.issues.map((issue, i) => (
                      <Stack key={i} spacing={0.5} sx={{ mt: 0.75 }}>
                        <Box>
                          <Chip
                            label={issue.label}
                            size="small"
                            color={
                              issue.type === "participant_mismatch" ? "warning" : "default"
                            }
                          />
                        </Box>
                        {issue.explanation && (
                          <Typography variant="body2">{issue.explanation}</Typography>
                        )}
                        {issue.evidence && (
                          <Box
                            sx={{
                              bgcolor: "action.hover",
                              borderRadius: 1,
                              px: 1.5,
                              py: 1,
                            }}
                          >
                            <Typography variant="caption" color="text.secondary">
                              {issue.evidence.filename}
                            </Typography>
                            <Typography
                              variant="body2"
                              sx={{ fontFamily: "monospace", whiteSpace: "pre-wrap" }}
                            >
                              {issue.evidence.excerpt}
                            </Typography>
                          </Box>
                        )}
                      </Stack>
                    ))}
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
