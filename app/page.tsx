import Container from "@mui/material/Container";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";

export default function HomePage() {
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
        <Typography variant="body1" color="text.secondary">
          Starter setup. Authentication, uploads, and quotation checking come in
          later steps.
        </Typography>
      </Box>
    </Container>
  );
}
