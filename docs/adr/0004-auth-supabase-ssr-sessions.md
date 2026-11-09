# ADR-0004: Authentication with Supabase SSR sessions and email confirmation

## Date and status
2026-11-09. Accepted.

> Builds on [ADR-0003](0003-use-supabase.md), which chose Supabase for Auth,
> PostgreSQL, and Storage and set the access model (ordinary requests run under
> the signed-in user's session; owner-only RLS is the enforcing boundary). This
> ADR records *how* sign-up / log-in / sign-out were implemented for the Next.js
> App Router (checklist item 9).

## Context
We needed email/password sign-up, log-in, and sign-out, wired so that every
request — in the browser and on the server — runs as the signed-in user, because
owner-only RLS reads that identity to scope data. We also needed the sign-up
email-confirmation step to reliably establish a session.

## Decision

1. **Keeping users signed in (cookie-based SSR sessions).** We use the
   `@supabase/ssr` package. The user's session (access + refresh tokens) is kept
   in HTTP cookies, not in a server secret. A browser client
   (`lib/supabase/client.ts`) and a server client (`lib/supabase/server.ts`) both
   read those cookies, and the root `middleware.ts` checks the session on every
   matched request and refreshes the tokens when needed. So each request acts as
   that user, which is exactly what
   owner-only RLS needs. Ordinary requests use the **publishable** key only; no
   service-role key is used in the app.

2. **Token-hash confirmation link.** Email confirmation is ON, so sign-up creates
   an unconfirmed account and sends a confirmation link that must establish a
   server-side session. The default link uses the PKCE "code" flow, which needs a
   code-verifier stored at sign-up. In our setup, clicking the emailed link
   failed to confirm the account. The likely cause was that the code verifier was
   unavailable when the link opened. We therefore changed the "Confirm signup"
   email template to the **token-hash** form
   (`{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email`), which
   our `app/auth/confirm` route verifies with `verifyOtp` and which needs no
   code-verifier. That route still accepts the code flow as a fallback.

3. **Email setup remaining before launch.** Supabase's built-in email sender only
   delivers to project team members and is rate-limited (~2 emails/hour) — fine
   for development, but not for real users. **Before launch we must configure a
   custom SMTP sender** (which removes the recipient restriction and raises the
   limit) while keeping email confirmation ON.

## Consequences
- **Public config only in the repo.** `.env.local` holds `NEXT_PUBLIC_SUPABASE_URL`
  and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (both public, git-ignored). The
  service-role/secret key is never placed in the app.
- **Some settings live in the hosted dashboard, not the code**, so they are
  recorded here and in `docs/development-checklist.md`: Site URL + allowed
  redirect URLs, "Confirm email" ON, and the token-hash "Confirm signup" template.
- **Email confirmation links are single-use** (as all email OTP links are) and can
  be consumed by email link-scanners; if that causes problems we revisit.
- **Next.js version note:** on Next.js 15 (our version) the file is `middleware.ts`;
  Next.js 16 renames it to `proxy.ts`.
- **Still open / out of scope here:** route protection and the stronger
  `getUser()` revocation check on protected pages, password reset, and the MVP #1
  feature screens — these come as auth is extended in item 9.
