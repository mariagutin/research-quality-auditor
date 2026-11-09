// Session-refresh helper for Next.js middleware.
//
// WHAT THIS IS
// `updateSession` runs on every matched request (wired up in the root
// middleware.ts). Its job is to keep the signed-in user's Supabase auth session
// fresh: it reads the session cookies off the incoming request, lets the
// Supabase client rotate the access/refresh tokens if they are near expiry, and
// writes the updated cookies back onto the response. Without this, server-side
// requests would gradually lose the user's identity and owner-only RLS would
// start rejecting their own rows.
//
// This does NOT protect routes yet (no redirects). Route protection and the
// stronger `getUser()` revocation check come with the sign-in screens and the
// pages that need them.

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !publishableKey) {
    throw new Error(
      "Missing Supabase env vars. Set NEXT_PUBLIC_SUPABASE_URL and " +
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in .env.local.",
    );
  }

  const supabase = createServerClient(url, publishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value),
        );
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options),
        );
      },
    },
  });

  // IMPORTANT: Do NOT run any other code between creating the client above and
  // the call below. Doing so can cause hard-to-debug session issues where the
  // user appears randomly logged out.
  //
  // getClaims() verifies the token's signature/expiry and triggers a refresh
  // when needed. (getUser() additionally detects a session revoked on another
  // device; we'll use it on protected routes where that gap matters.)
  await supabase.auth.getClaims();

  // IMPORTANT: Return `supabaseResponse` unchanged so the refreshed auth cookies
  // stay in sync between the request and the browser.
  return supabaseResponse;
}
