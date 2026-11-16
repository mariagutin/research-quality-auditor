# Hosted live verification — Week 4

> Manual, by-hand verification of the **deployed** app, performed by Maria on
> **2026-11-15**. Synthetic data only (the `~/Desktop/rqa-sample/` report + P03/P05
> transcripts); no real research data. These are browser-observed results against the
> live site, recorded as the Week 4 hosted test evidence.

| | |
|---|---|
| App (production) | https://research-quality-auditor.vercel.app |
| Supabase project | `czrjqgxmtpdxfkohwlkh` (migrations 1–11 applied; see [`hosted-migration-review.md`](./hosted-migration-review.md)) |
| Auth email | Custom SMTP via Resend, domain `gutinmaria.com` |
| Browsers | Safari (normal window = account A; separate **private** window = account B) |

## Results — all passed

### 1. Sign-up → confirmation email → sign-in (end to end)
Created an account on the live site, **received the confirmation email**, followed its
link back to the deployed app (`/auth/confirm`), and signed in. This exercises the full
hosted auth path: `signUp` with `emailRedirectTo` → Resend-delivered email → the
`/auth/confirm` callback exchanging the code for a session.

### 2. Upload + run check (synthetic report + P03/P05 transcripts)
Uploaded the synthetic report with the P03/P05 transcripts and ran the check:
**6 quotations checked, 4 issues found** — including the **documented "Nimbus" false
alert** (a product name in double quotes extracted as a quotation). This matches the
expected behavior recorded in [`known-limitations.md`](./known-limitations.md) (QE-1),
confirming the extractor and checker behave on hosted exactly as locally.

### 3. Decision persistence (across refresh and re-login)
Selected **Dismiss** on the "Nimbus" issue. The decision and the **"1 of 4 issues
reviewed"** progress **persisted after a page refresh, and after signing out and back
in** — confirming the decision is stored server-side (not just client state) and is
correctly scoped to the owner's account.

### 4. Owner-only access — second account sees nothing (browser/app level)
Signed into a **second account** (account B) in a separate Safari **private** window.
Its **review list was empty** — none of account A's reviews were visible.

### 5. Owner-only access — direct URL to another account's review is 404
While signed in as **account B**, opened **account A's direct review URL**. The app
returned **404 with no review content displayed** — account B could neither see nor
reach account A's review through the application.

### 6. Original account still intact
Returned to the original window as **account A** and refreshed: the review **remained
accessible** and the **Dismiss decision was still saved**. Account B's attempt in #5 had
no effect on account A's data.

### 7. Mobile (phone) — upload + run check on iPhone Safari
On an **iPhone in Safari**, uploaded the synthetic report and the **two transcripts**
through the **Files picker** and **ran the quotation check successfully** on the live
site. This confirms the upload + check flow works on a phone-sized screen and with
iOS Safari's file picker.

> **Scope:** this mobile check covered **only** the file upload and running the check.
> Sign-up / confirmation and the Dismiss (decision) flow were **not** exercised on
> mobile in this test — those remain confirmed on desktop only (checks #1 and #3).

## Scope note — what these isolation checks do and do **not** cover

Checks #4 and #5 demonstrate **owner-only access as observed through the deployed
application** — the review list and the review route return nothing for a non-owner.
This is browser/app-level behavior backed by the owner-only RLS policies.

These are **not** a hosted Storage API isolation test. We have **not** performed a
direct Storage-API cross-account test on hosted (signing in as a second user and
attempting to list/download/delete another user's files straight through the Storage
endpoints). That direct Storage isolation test has only been run against the **local**
stack (`scripts/storage-isolation.local-test.mts`); it was not repeated on hosted. Do
not read #4/#5 as hosted Storage API isolation evidence.

## Status

- Live manual verification complete on https://research-quality-auditor.vercel.app;
  all seven checks passed with synthetic data (checks #1–#6 on desktop Safari, check
  #7 on iPhone Safari).
- Mobile coverage is partial by design: iPhone Safari confirmed **upload + run check**
  only; sign-up and the Dismiss flow were verified on desktop, not on mobile.
- Not done: a direct hosted Storage API isolation test (local only so far).
