# Dependency audit — review before deployment

Record of `npm audit` findings to review before the app is deployed. These are
**not** from our own code; they are known advisories in the Next.js / Material UI
build chain. Nothing here has been changed or fixed — this is a record only.

- **Audited:** 2026-11-07
- **Command:** `npm audit` (read-only)
- **Totals:** 3 vulnerabilities (2 moderate, 1 high)
- **Introduced by the Supabase client install?** No. The packages added on
  2026-11-07 (`@supabase/supabase-js`, `@supabase/ssr`) introduced **no**
  advisories; all findings pre-date that install and come from the starter app's
  Next.js + MUI dependencies.

## Affected packages

| Package | Installed | Severity | How it's pulled in | Fix available |
|---|---|---|---|---|
| `postcss` | 8.4.31 | **high** (plus moderate) | transitive, via `next` | only by upgrading `next` to 16.x (**major**) |
| `next` | 15.5.29 | moderate | direct, and via `@mui/material-nextjs` | `next` 16.4.5 (**major**) |
| `@mui/material-nextjs` | 6.5.0 | moderate | direct | `@mui/material-nextjs` 9.5.0 (**major**) |

## Advisory IDs

**`postcss`** (the high-severity root cause; all source-map / stringify issues):
- GHSA-6g55-p6wh-862q — Arbitrary file read / info disclosure via attacker-controlled `sourceMappingURL` (high; affects `<= 8.5.11`)
- GHSA-r28c-9q8g-f849 — Path traversal in previous source-map auto-loading → arbitrary `.map` disclosure (high; `<= 8.5.17`)
- GHSA-fxqj-rqcc-2cmp — Incomplete fix of GHSA-6g55-p6wh-862q; reads arbitrary `.map` when `from` is unset (moderate; `<= 8.5.22`)
- GHSA-qx2v-qp2m-jg93 — XSS via unescaped `</style>` in CSS stringify output (moderate; `< 8.5.10`)

**`next`** and **`@mui/material-nextjs`**: flagged moderate; resolved only by the
major upgrades listed in the table above. (Run `npm audit` for the live advisory
links on these two.)

## Assessment

- The `postcss` issues are **build-time** weaknesses (processing attacker-controlled
  CSS / source-map comments), not flaws in our app's request-time runtime, so the
  practical risk to the deployed app is low given we build our own CSS.
- All available fixes are **major** version upgrades (`next` 15 → 16,
  `@mui/material-nextjs` 6 → 9), which can introduce breaking changes.

## Recommended before deployment (not yet done)

- Decide whether to upgrade `next` to 16.x and `@mui/material-nextjs` to 9.x
  (test locally; likely an ADR, since a Next.js major is a significant change).
- Re-run `npm audit` after any upgrade to confirm the advisories clear.
- No `npm audit fix --force` has been run (it would force the major upgrades).
