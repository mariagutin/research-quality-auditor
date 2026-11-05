# ADR-0002: Host on Vercel

## Date and status
[Decision date — please confirm]. Accepted.

> Hosting on Vercel was specified in the Week 2 Technical Build Plan. The Options
> below record the reasoning behind the choice. No formal evaluation of
> alternatives is documented.
>
> [Confirm: is hosting on Vercel a course requirement? If so, note that here.]

## Context
We chose Next.js for the interface and server logic (ADR-0001). That code now needs
somewhere to run: it has to serve the screens, run the server-side logic (file
validation, the quotation check, saving results), and keep secrets such as the AI
API key off the browser (NFR-01). The quotation check may be slow and may need to
talk to an external AI provider, so how the host runs server code matters.

## Options

- Vercel:
  - Good: First-class support for Next.js (the two are made to work together);
    deploys straight from the GitHub repository; runs our server logic as serverless
    functions; provides environment variables for secrets.
  - Bad: Serverless functions have execution limits (time and memory), so a
    long-running check may need to be reshaped; some coupling to one vendor.
- A self-managed Node server (for example a VPS or container host):
  - Good: Full control over how the server runs, including long-running work with no
    per-request time limit.
  - Bad: We run and secure the server ourselves — operating system, scaling, HTTPS,
    deploys — which is more work and more to get wrong for an MVP.
- Another managed platform (for example a container platform or a different host):
  - Good: Also removes server management; some options allow longer-running
    processes than serverless functions.
  - Bad: Less turnkey for Next.js than Vercel; more configuration to reach the same
    "push to deploy" workflow.

## Decision
Host on **Vercel**, because it is the most direct way to run a Next.js app:
push-to-deploy from GitHub, serverless functions for our Tier 2 logic, and built-in
environment variables for keeping credentials server-side.

## Consequences
- Secrets (database credentials, AI API key) live in Vercel's server-side
  environment, never in browser code or the repository (NFR-01).
- Serverless execution limits interact directly with two still-open architecture
  decisions: **upload limits** and **processing shape** (single request vs.
  background work). These must be settled before building the long-running check, so
  a check does not exceed a function's time limit (see `docs/architecture.md` →
  Open decisions).
- We accept some coupling to Vercel; moving later would mean re-creating the deploy
  and serverless setup elsewhere.
- Next steps: connect the GitHub repo to a Vercel project and configure environment
  variables once the AI provider and Supabase keys exist.

## Fit check against current Vercel limits

Checked on 2026-11-05 against the official
[Vercel Functions Limits](https://vercel.com/docs/functions/limitations) page (last
updated 2026-08-24) and the KB guide
[How to bypass the body size limit](https://vercel.com/kb/guide/how-to-bypass-vercel-body-size-limit-serverless-functions).

**Confirmed facts.** Function duration (Fluid compute, Node.js): Hobby = 300s
default and maximum (hard cap); Pro/Enterprise = 300s default, 800s maximum (GA),
1800s beta; over-run returns `504 FUNCTION_INVOCATION_TIMEOUT`, raised via
`maxDuration`. Request/response body size = 4.5 MB, not configurable; over-run
returns `413 FUNCTION_PAYLOAD_TOO_LARGE`; the documented workaround is to upload
files directly to storage. I/O wait (AI/DB calls) is not billed as active CPU but
still counts toward `maxDuration`. [Vercel
Workflows](https://vercel.com/docs/workflows) runs without the duration limit.

**Assessment.** The 4.5 MB body limit bites only if uploads route *through* a
function; `.md` files are small (assumption — not yet bounded) and can go
client-direct to Supabase Storage to avoid it. The real risk is check duration —
AI-assisted extraction, candidate-finding, and verbatim verification across
transcripts — which is untested and tightest on Hobby's hard 300s cap. Both are
reasonably addressable (bound upload limits, raise `maxDuration` on Pro, or move to
background processing/Workflows), and map onto the existing "upload limits" and
"processing shape" open decisions in `docs/architecture.md`.

**Conclusion.** Vercel appears suitable for the planned workflow, pending tests with
representative files to confirm a real check completes within the chosen plan's
duration limit. Vercel remains the selected host; no alternative is recommended. We
start on the **Hobby** plan for development and noncommercial testing (note its hard
300s duration cap), pending those results. Upload limits are not yet decided. Propose
initial limits during implementation, then validate them using representative reports
and transcripts before confirming the hosting plan and processing approach.

## Open implementation questions

1. **Vercel plan (Hobby vs Pro).** Starting on Hobby for development and
   noncommercial testing (300s hard duration cap, no extension); revisit Pro (up to
   800s GA) if validation shows checks need longer.
2. **Does one check fit the duration cap?** Measure a real check's end-to-end time
   with representative files and confirm it completes within the chosen plan's
   [`maxDuration`](https://vercel.com/docs/functions/configuring-functions/duration)
   (ties to the "upload limits" and "processing shape" open decisions).
3. **`maxDuration` value.** Whether to raise it above the 300s default, and to what
   value (above 300s requires Pro/Enterprise).
4. **Upload path.** Client-direct upload to Supabase Storage (avoids the 4.5 MB
   function body limit) vs. through a Vercel function (subject to it). Left open;
   `docs/architecture.md` is unchanged.
5. **Background processing / Vercel Workflows.** If a check cannot reliably fit one
   request, decide whether to use background processing or Workflows (deferred with
   the "processing shape" open decision).
