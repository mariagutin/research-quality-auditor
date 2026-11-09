import Container from "@mui/material/Container";
import Box from "@mui/material/Box";
import LoginForm from "./login-form";

export default function LoginPage() {
  return (
    <Container maxWidth="sm">
      <Box
        sx={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          py: 8,
        }}
      >
        <LoginForm />
      </Box>
    </Container>
  );
}
