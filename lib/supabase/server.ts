// Server-side Supabase client for the Research Quality Auditor app.
//
// WHAT THIS IS
// A factory that builds a Supabase client for use in Server Components, Route
// Handlers, and Server Actions. Unlike the browser client, it reads and writes
// the user's auth session through Next.js cookies (via `next/headers`), so every
// server-side request runs AS THE SIGNED-IN USER. That is what our owner-only
// RLS policies rely on to scope every row to its owner (see docs/architecture.md
// lines 103-108): ordinary requests use the user's own session, never a
// privileged service-role key.
//
// It reads the same two PUBLIC env vars as the browser client. No secret here.

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function createClient() {
  // In Next.js 15, cookies() is async and must be awaited.
  const cookieStore = await cookies();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !publishableKey) {
    throw new Error(
      "Missing Supabase env vars. Set NEXT_PUBLIC_SUPABASE_URL and " +
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in .env.local.",
    );
  }

  return createServerClient(url, publishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // `setAll` was called from a Server Component, where cookies are
          // read-only. This is safe to ignore because the middleware
          // (lib/supabase/middleware.ts) refreshes the session on every request.
        }
      },
    },
  });
}
