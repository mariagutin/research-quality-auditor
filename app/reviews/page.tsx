// Lists the signed-in researcher's saved checks, newest first. Owner-only RLS
// means this query returns only this user's reviews; a stranger sees nothing.

import { redirect } from "next/navigation";
import Link from "next/link";
import Container from "@mui/material/Container";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Chip from "@mui/material/Chip";
import Button from "@mui/material/Button";
import { createClient } from "@/lib/supabase/server";
import { resumePendingDeletions } from "@/lib/reviews/delete-review";
import { loadReviewProgress } from "@/lib/reviews/list-progress";
import { reviewListStatus } from "@/lib/reviews/list-status";

const DATE_FORMAT = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric" });

export default async function ReviewsListPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Owner-driven recovery: finish any interrupted deletions' file cleanup. Best-
  // effort -- never block or fail the page on it.
  try {
    await resumePendingDeletions(supabase, user.id);
  } catch {
    /* best-effort cleanup */
  }

  const { data: reviews } = await supabase
    .from("reviews")
    .select("id, name, processing_status, created_at")
    .order("created_at", { ascending: false });

  // Review progress for completed checks only. `null` means the counts couldn't be
  // loaded completely; those checks show "Review status unavailable".
  const completedIds = (reviews ?? []).filter((r) => r.processing_status === "complete").map((r) => r.id);
  const progress = await loadReviewProgress(supabase, user.id, completedIds);

  return (
    <Container maxWidth="md" sx={{ py: 6 }}>
      <Stack spacing={3}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={2}>
          <Typography variant="h4" component="h1">
            Your checks
          </Typography>
          <Button component={Link} href="/reviews/new" variant="contained">
            Start a new check
          </Button>
        </Stack>

        {!reviews || reviews.length === 0 ? (
          <Typography color="text.secondary">No checks yet.</Typography>
        ) : (
          <Stack spacing={1} component="ul" sx={{ listStyle: "none", m: 0, p: 0 }}>
            {reviews.map((review) => (
              <Box key={review.id} component="li">
                <Box
                  component={Link}
                  href={`/reviews/${review.id}`}
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 2,
                    p: 2,
                    borderRadius: 1,
                    border: 1,
                    borderColor: "divider",
                    textDecoration: "none",
                    color: "inherit",
                    "&:hover": { bgcolor: "action.hover" },
                  }}
                >
                  <Box sx={{ minWidth: 0 }}>
                    <Typography
                      variant="subtitle1"
                      sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    >
                      {review.name}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {DATE_FORMAT.format(new Date(review.created_at))}
                    </Typography>
                  </Box>
                  <Chip
                    size="small"
                    label={reviewListStatus(review.processing_status, progress?.get(review.id) ?? null)}
                    color={review.processing_status === "complete" ? "primary" : "default"}
                  />
                </Box>
              </Box>
            ))}
          </Stack>
        )}
      </Stack>
    </Container>
  );
}
