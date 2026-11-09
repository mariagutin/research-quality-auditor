import Container from "@mui/material/Container";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import Alert from "@mui/material/Alert";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { signout } from "@/app/login/actions";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ confirmed?: string }>;
}) {
  const { confirmed } = await searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <Container maxWidth="md">
      <Box
        sx={{
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: 2,
          py: 8,
        }}
      >
        <Typography variant="h3" component="h1">
          Research Quality Auditor
        </Typography>

        {confirmed && (
          <Alert severity="success" role="status">
            Your email is confirmed and you&apos;re signed in.
          </Alert>
        )}

        {user ? (
          <>
            <Typography variant="body1">
              Signed in as <strong>{user.email}</strong>.
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Uploads and quotation checking come in later steps.
            </Typography>
            <Box component="form" action={signout}>
              <Button type="submit" variant="outlined">
                Sign out
              </Button>
            </Box>
          </>
        ) : (
          <>
            <Typography variant="body1" color="text.secondary">
              You are not signed in.
            </Typography>
            <Button
              component={Link}
              href="/login"
              variant="contained"
              sx={{ alignSelf: "flex-start" }}
            >
              Sign up or log in
            </Button>
          </>
        )}
      </Box>
    </Container>
  );
}
