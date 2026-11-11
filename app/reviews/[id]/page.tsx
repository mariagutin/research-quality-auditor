// A saved check. Server component: loads the review and its documents AS the
// signed-in user (owner-only RLS means a stranger's id simply returns nothing),
// and shows the saved label, its pre-check status, and the file list.

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
import { createClient } from "@/lib/supabase/server";
import RunCheckButton from "./run-check-button";

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
    .select("role, filename, participant_id")
    .eq("review_id", id)
    .order("role", { ascending: true })
    .order("filename", { ascending: true });

  const isPreCheck = review.processing_status === "draft";

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
                : review.processing_status === "complete"
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
