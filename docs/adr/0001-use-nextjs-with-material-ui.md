# ADR-0001: Use Next.js with Material UI

## Date and status
[Decision date — please confirm]. Accepted.

> This stack was specified in the Week 2 Technical Build Plan and the starter app
> (Next.js App Router + TypeScript + Material UI) is already built and pushed. The
> Options below record the reasoning behind the choice. No formal evaluation of
> alternatives is documented.
>
> [Confirm: is this stack a course requirement? If so, note that here — it would
> make the choice a given rather than an open comparison.]

## Context
Research Quality Auditor is a three-tier app (see `docs/architecture.md`). We need
two things close together: the browser screens a researcher uses (sign in, upload,
review issues, record decisions) and the server code that validates files, runs the
quotation check, and saves results. The app is intended to run on Vercel. We also
have real accessibility requirements — keyboard operation, visible focus,
non-color status indicators, and screen-reader labels (NFR-06, NFR-07, NFR-08) —
so a mature, accessible component set is valuable rather than hand-building one.

## Options

- Plain React (for example Vite or Create React App) plus a separate backend:
  - Good: Simple to start; the browser code is just React with no server-vs-browser
    rules to learn.
  - Bad: We would need a second project or service for the Tier 2 server logic,
    plus our own routing and build setup — more moving parts to wire together and
    deploy.
- Next.js (App Router) with TypeScript:
  - Good: Holds the screens and the server code in one project, which covers two of
    our three tiers; strong fit with Vercel; TypeScript catches mistakes early.
  - Bad: We have to learn which code runs in the browser and which runs on the
    server, and set up Material UI correctly for server-side rendering.
- For the component layer — Material UI versus hand-rolled components/CSS:
  - Good (Material UI): Ready-made, broadly accessible components (forms, dialogs,
    buttons) so we spend effort on the review workflow, not on building a UI kit.
  - Bad (Material UI): Adds a dependency and a theming pattern to learn; accessible
    *defaults* still have to be used correctly — the library does not guarantee our
    NFRs on its own.

## Decision
Use **Next.js (App Router) with TypeScript and Material UI**, because one project
covers both the interface (Tier 1) and the server logic (Tier 2), it deploys
cleanly to Vercel, and Material UI gives us accessible building blocks so we can
focus on the quotation-review workflow.

## Consequences
- We maintain the distinction between browser code and server code, and keep all
  secrets and AI API keys in server code only (NFR-01).
- Material UI's theme file needs a `"use client"` line, and the App Router needs
  the MUI cache provider for correct server-side styling — both are already wired
  in the starter.
- Accessibility is not automatic: we still have to apply labels, focus indicators,
  and non-color status cues to meet NFR-06/07/08.
- Next steps build on this stack: authentication screens, the upload/acknowledgment
  flow, and the results/review screens.
