"use client";

// Sign-up / login form. One form, two submit buttons (Log in / Sign up); the
// clicked button sends its `intent` to the server action. Success and error
// messages come back through useActionState and render as accessible alerts.

import { useActionState } from "react";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import Alert from "@mui/material/Alert";
import Link from "next/link";
import { authenticate, type AuthState } from "./actions";

const initialState: AuthState = {};

export default function LoginForm() {
  const [state, formAction, isPending] = useActionState<AuthState, FormData>(
    authenticate,
    initialState,
  );

  return (
    <Box component="form" action={formAction} sx={{ width: "100%", maxWidth: 440 }}>
      <Stack spacing={2}>
        <Typography variant="h4" component="h1">
          Sign up or log in
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Returning? <strong>Log in</strong>. New here? <strong>Sign up</strong> —
          we&apos;ll email you a confirmation link.
        </Typography>

        {state.error && (
          <Alert severity="error" role="alert">
            {state.error}
          </Alert>
        )}
        {state.message && (
          <Alert severity="success" role="status">
            {state.message}
          </Alert>
        )}

        <TextField
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          required
          fullWidth
        />
        <TextField
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          fullWidth
          helperText="At least 6 characters."
        />

        <Stack direction="row" spacing={2}>
          <Button
            type="submit"
            name="intent"
            value="login"
            variant="contained"
            disabled={isPending}
          >
            Log in
          </Button>
          <Button
            type="submit"
            name="intent"
            value="signup"
            variant="outlined"
            disabled={isPending}
          >
            Sign up
          </Button>
        </Stack>

        <Button component={Link} href="/" size="small" sx={{ alignSelf: "flex-start" }}>
          ← Back to home
        </Button>
      </Stack>
    </Box>
  );
}
