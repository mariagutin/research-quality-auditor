// Handles the confirmation link from the sign-up email.
//
// Supabase can send the link in two shapes depending on the email template:
//   - token-hash template: /auth/confirm?token_hash=...&type=email  -> verifyOtp
//   - default (code) flow:  /auth/confirm?code=...                   -> exchangeCodeForSession
// We support both. On success a session cookie is set and we send the user home
// with ?confirmed=1; on failure we send them to a friendly error page.

import { type EmailOtpType } from "@supabase/supabase-js";
import { type NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";

  const supabase = await createClient();

  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) {
      return NextResponse.redirect(new URL(`${next}?confirmed=1`, origin));
    }
  } else if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(new URL(`${next}?confirmed=1`, origin));
    }
  }

  return NextResponse.redirect(new URL("/auth/auth-code-error", origin));
}
