import Container from "@mui/material/Container";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Link from "next/link";

export default function AuthCodeErrorPage() {
  return (
    <Container maxWidth="sm">
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
        <Typography variant="h4" component="h1">
          Confirmation link problem
        </Typography>
        <Alert severity="error" role="alert">
          We couldn&apos;t confirm your email with that link. It may have expired
          or already been used.
        </Alert>
        <Typography variant="body2" color="text.secondary">
          Try logging in. If it still fails, sign up again to get a fresh link.
        </Typography>
        <Button
          component={Link}
          href="/login"
          variant="contained"
          sx={{ alignSelf: "flex-start" }}
        >
          Back to sign in
        </Button>
      </Box>
    </Container>
  );
}
