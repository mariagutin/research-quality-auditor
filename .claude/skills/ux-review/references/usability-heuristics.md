# Nielsen's 10 Usability Heuristics — Evaluation Criteria

Source: Nielsen Norman Group, "10 Usability Heuristics for User Interface
Design" (nngroup.com). Use this file during Step 3 of the ux-review workflow.

## How to classify each heuristic

Give every heuristic one status:
- **Issue found** — concrete evidence of a usability problem.
- **No issue observed** — positive evidence it is handled well (name the evidence).
- **Not verifiable** — inputs are insufficient; say what is needed.

Never default to "No issue observed" just because nothing jumped out. If the
relevant evidence isn't in the inputs (e.g. you can't see the error state, or the
handler code isn't shown), the honest status is **Not verifiable**.

## Scope note (accessibility)

Some cues below touch accessibility (labels, `aria-*`). Treat them here only as
usability signals and **flag** deeper issues; detailed WCAG conformance belongs
to the separate `accessibility-audit` skill.

## Contents
1. Visibility of System Status
2. Match Between the System and the Real World
3. User Control and Freedom
4. Consistency and Standards
5. Error Prevention
6. Recognition Rather than Recall
7. Flexibility and Efficiency of Use
8. Aesthetic and Minimalist Design
9. Help Users Recognize, Diagnose, and Recover from Errors
10. Help and Documentation

---

## 1. Visibility of System Status
**Definition:** Keep users informed about what is going on through appropriate
feedback within a reasonable time.

**In a screenshot:** Loading indicators, progress bars, confirmation messages;
clear current state (selected tab, active step, logged-in user).

**In code:** Loading/spinner states for async calls; success/error feedback after
submits; `aria-live` regions for dynamic updates; disabled/busy button states.

**Common violations:** Action with no feedback; silent background processing; no
indication of which page/step the user is on.

**Not verifiable when:** You can't see post-action states, or async handlers
aren't in the provided code.

## 2. Match Between the System and the Real World
**Definition:** Speak the users' language — familiar words and concepts; follow
real-world conventions in a natural, logical order.

**In a screenshot:** Plain language over jargon; obvious icons; logical ordering;
familiar formats (dates, currency).

**In code:** Copy strings matching user vocabulary (not `usr_fname`); correct
date/number formatting; sensible `<input type>`.

**Common violations:** System jargon/error codes shown to users; unlabeled
unfamiliar icons; developer-centric terminology.

**Not verifiable when:** Copy is placeholder/lorem ipsum, or localization isn't shown.

## 3. User Control and Freedom
**Definition:** Users make mistakes and need a clearly marked "emergency exit" —
support undo and redo.

**In a screenshot:** Visible Cancel/Close/Back; a way out of modals and multi-step
flows; undo for destructive actions.

**In code:** Dismissible modals (Esc + close); Cancel on forms; undo patterns; no
forced, unescapable flows.

**Common violations:** Modal with no close; destructive action with no undo; flow
that traps the user.

**Not verifiable when:** You only see one screen of a multi-step flow.

## 4. Consistency and Standards
**Definition:** Users shouldn't wonder whether different words/actions mean the
same thing. Follow platform and industry conventions (Jakob's Law).

**In a screenshot:** Consistent button styles, terminology, icons, layout;
conventions respected (e.g. primary action placement).

**In code:** Reuse of shared components/design tokens vs one-offs; consistent
naming; semantic elements (`<button>` for actions, `<a>` for navigation).

**Common violations:** Same concept labeled differently; a `<div>` as a button;
inconsistent spacing/color for the same component.

**Not verifiable when:** Only one screen/component is provided (consistency is
cross-screen).

## 5. Error Prevention
**Definition:** Prevent problems before they happen — eliminate error-prone
conditions or confirm before the user commits.

**In a screenshot:** Sensible defaults; constraints (disabled invalid options);
confirmation for destructive actions; helpful inline hints.

**In code:** Validation and constraints (`type`, `min`/`max`, `pattern`,
`required`); submit disabled until valid; confirmation on destructive calls.

**Common violations:** Free-text where a picker fits; no confirmation before
delete; validation only after submit with data loss.

**Not verifiable when:** Validation logic isn't in the provided code.

## 6. Recognition Rather than Recall
**Definition:** Minimize memory load by making elements, actions, and options
visible or easily retrievable.

**In a screenshot:** Visible options; persistent labels (not placeholder-only);
breadcrumbs; previously entered data shown.

**In code:** `<label>` elements (not placeholder-as-label); autocomplete/suggestions;
context carried between steps.

**Common violations:** Placeholder-as-label; requiring users to remember a code
across screens; hidden navigation.

**Not verifiable when:** The broader flow (what users must carry between steps)
isn't shown.

## 7. Flexibility and Efficiency of Use
**Definition:** Accelerators — unseen by novices — speed up experts; let users
tailor frequent actions.

**In a screenshot:** Shortcuts, bulk actions, saved views, recently used items.

**In code:** Keyboard shortcuts; batch operations; persisted preferences; sensible
tab order.

**Common violations:** No bulk action; expert workflows forced through the slow
path; no keyboard support.

**Not verifiable when:** Interaction/keyboard behavior isn't observable from a
static image.

## 8. Aesthetic and Minimalist Design
**Definition:** Interfaces shouldn't contain irrelevant or rarely needed
information — every extra unit competes with relevant content. (Not "flat design".)

**In a screenshot:** Clear visual hierarchy; focus on the primary task; limited
competing CTAs; whitespace used well.

**In code:** Progressive disclosure of advanced options; content prioritized by
user goal.

**Common violations:** Too many equal-weight CTAs; dense text walls; decorative
clutter hiding key actions.

**Not verifiable when:** Rarely — this is largely judgeable from a screenshot.

## 9. Help Users Recognize, Diagnose, and Recover from Errors
**Definition:** Error messages in plain language (no codes), stating the problem
precisely and suggesting a solution.

**In a screenshot:** Errors near the cause; plain-language wording; visible
treatment (color + icon + text); a suggested fix.

**In code:** Messages tied to the field (`aria-describedby`); no raw stack traces
or codes surfaced; error text that says how to fix.

**Common violations:** "Error 500" shown to users; generic "Something went wrong";
errors far from their field.

**Not verifiable when:** No error state is included in the inputs.

## 10. Help and Documentation
**Definition:** Ideally the system needs no explanation; when help is needed, make
it easy to search, task-focused, concise, and listing concrete steps.

**In a screenshot:** Contextual help (tooltips, inline hints); useful empty states;
discoverable help entry point.

**In code:** Accessible tooltips/help toggles; empty-state components with guidance;
help tied to the task in view.

**Common violations:** No guidance on complex fields; blank empty states; help
buried or absent.

**Not verifiable when:** Empty/help states aren't among the provided screens.
