# Running the app against local Supabase

How to run the Next.js app against the **local, disposable** Supabase stack with a
test account — so you can click through features (uploads, saving a check, the
retry paths) without touching the hosted project.

> Everything here is local only. It never changes hosted Supabase. The override
> file below is git-ignored, so none of this is committed.

## Prerequisites

1. **Docker is running.**
2. **The local Supabase stack is up:**
   ```sh
   npx supabase start      # first time or after stopping
   npx supabase status      # shows URLs + keys; confirm it's running
   ```
3. **Migrations are applied to the local database** (also gives a clean slate):
   ```sh
   npx supabase db reset    # LOCAL only — drops & recreates the local DB,
                            # replays every migration in supabase/migrations/
   ```

## Point the app at local (instead of hosted)

The app reads `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
`.env.local` holds the **hosted** values. To override them for local development
only, create **`.env.development.local`** (git-ignored via `.env*.local`):

```sh
# .env.development.local  — LOCAL dev override; delete to go back to hosted.
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<PUBLISHABLE_KEY from `npx supabase status`>
```

In `next dev`, `.env.development.local` takes precedence over `.env.local`, so the
app talks to local. `.env.local` (hosted) is left untouched. On startup Next prints
`Environments: .env.development.local, .env.local` — that confirms the override
loaded. **Restart the dev server after creating or deleting this file** (the
`NEXT_PUBLIC_*` values are read at startup).

Get the local publishable key (and other values) any time with:
```sh
npx supabase status          # human-readable
npx supabase status -o json  # machine-readable
```

## Run it

```sh
npm run dev      # http://localhost:3000
```

## Make a local test account

Local auth has **email confirmation turned off** (`[auth.email] enable_confirmations
= false` in `supabase/config.toml`), so no email step is needed:

1. Go to http://localhost:3000 → **Sign up or log in**.
2. Enter any email and a 6+ character password → **Sign up** (the account is live
   immediately).
3. Click **Log in** with the same credentials → you're signed in.

(If confirmations were on, sign-up emails would appear in the local **Mailpit**
inbox — the `MAILPIT_URL` shown by `npx supabase status` — not a real inbox.)

## Try the upload flow

From the home page, **Start a new check**:

1. Tick **I understand how my research data is handled** — the form appears.
2. **Report:** choose a `.md` file. **Transcripts:** add one or more `.md` files and
   type each confirmed participant id (e.g. `P03`). A transcript must contain that
   id as a speaker label (a line like `P03:`).
3. **Save check** — files upload to your private `review-files` folder, the server
   verifies them and records the review, and the saved check opens.

Retry behaviour you can exercise:
- **Invalid file** (e.g. a transcript with no `P03:` label) → it's rejected and
  nothing is saved; **Replace** the file (a change that starts a new save).
- **Interrupted / unconfirmed save** → a **Try again** button finishes the same
  review once the connection recovers.

### What the browser run has confirmed

- **Recovery after an unconfirmed save:** with all files already uploaded, the
  final save step was made to fail (the database record service was stopped). The
  app showed *"We couldn't confirm your save. Try again to check its status."*,
  and **Try again** finished the **same** review once the service was back.
  Verified in the browser.
- **Still untested in the browser:** an interruption during the file **transfer
  itself** (an upload failing partway). The "didn't finish uploading → Try again,
  re-upload only the missing file under the same review id" path is covered by the
  automated test, but has not been reproduced by hand in the browser.

## Database tests (SQL)

The owner-only RLS, the `create_review_with_documents` function, and the Storage
bucket policies have synthetic SQL tests under `supabase/tests/`. See
`supabase/tests/README.md` for how to run each one against the local stack.

## TypeScript integration test (quotation check)

The quotation check logic (`lib/reviews/run-check.ts`) has a reusable local test
that runs the pure analysis on synthetic text and then a full `runReviewCheck`
against the local stack (it creates a synthetic user, uploads synthetic files,
runs the check, asserts the saved rows, and cleans up). From the repo root:

```sh
npx tsx scripts/run-check.local-test.mts
```

It auto-resolves the local keys from `npx supabase status` (or set
`SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` yourself).
Prereqs: Docker + `npx supabase start`, with migrations applied. A clean run
prints `PASS` lines and ends with `ALL CHECKS PASSED` (exit 0). **Local only.**

## Go back to hosted

```sh
rm .env.development.local
# restart: stop `npm run dev`, then `npm run dev` again
```

Deleting the override makes `next dev` fall back to `.env.local` (hosted).
