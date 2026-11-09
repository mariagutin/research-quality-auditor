// Browser-side Supabase client for the Research Quality Auditor app.
//
// WHAT THIS IS
// A small factory that builds a Supabase client configured for the browser,
// using the two PUBLIC values from .env.local:
//   - NEXT_PUBLIC_SUPABASE_URL             (our hosted project URL)
//   - NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (the publishable key; browser-safe)
// Creating the client makes NO network request on its own and holds no secret.
// It is `createBrowserClient` from @supabase/ssr, which is the client Supabase
// recommends for the Next.js App Router (it also manages auth-session cookies,
// which we will rely on in a later sign-in step).
//
// We read the publishable key from NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (the new
// name), not the older NEXT_PUBLIC_SUPABASE_ANON_KEY that some docs still show.

import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !publishableKey) {
    throw new Error(
      "Missing Supabase env vars. Set NEXT_PUBLIC_SUPABASE_URL and " +
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in .env.local.",
    );
  }

  return createBrowserClient(url, publishableKey);
}
