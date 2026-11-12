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

const DATE_FORMAT = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric" });

function statusLabel(status: string): string {
  if (status === "draft") return "Not checked yet";
  if (status === "complete") return "Checked";
  return status; // processing / failed / deleting
}

export default async function ReviewsListPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: reviews } = await supabase
    .from("reviews")
    .select("id, name, processing_status, created_at")
    .order("created_at", { ascending: false });

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
                    label={statusLabel(review.processing_status)}
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
