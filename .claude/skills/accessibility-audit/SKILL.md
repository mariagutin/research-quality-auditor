---
name: accessibility-audit
description: Audit user interfaces against WCAG 2.2 Level AA using available screenshots, application code, and, when supported, live testing tools. Identify evidence-backed accessibility barriers, distinguish confirmed failures from concerns needing verification, and recommend actionable fixes.
---

# Accessibility Audit

## Purpose and standard

Evaluate accessibility against WCAG 2.2 Level AA, including applicable Level A
success criteria. Treat WCAG conformance level and issue severity as different
concepts. Do not declare a whole website compliant or noncompliant based on a
limited sample.

## Instructions

### 1. Understand the context and select coverage

- Identify the input: screenshot, application code, live website, or a combination.
- Identify the product, audience, key tasks, and audit objective from the provided
  information. Ask for a missing URL, file, or task only when it prevents
  meaningful evaluation.
- For larger sites, select representative pages/templates and critical user flows
  (for example, registration, forms, checkout), including relevant states such as
  menus, dialogs, validation errors, and responsive layouts.
- Record exactly which pages, components, states, and flows were examined. Do not
  extrapolate findings to untested pages.

### 2. Match the testing method to the evidence and tools

- **Screenshots:** Assess visible text and layout, apparent focus indicators (only
  when a focused state is shown), potential contrast problems, and apparent target
  sizes. Do not infer keyboard operation, screen-reader announcements, DOM
  semantics, or exact contrast ratios from appearance alone.
- **Application code:** Inspect semantic structure, accessible names, labels,
  headings, image alternatives, ARIA use, states, error handling, and
  keyboard-related implementation. Distinguish what code establishes from what
  needs runtime verification.
- **Live website:** When capable browser/testing tools are available, inspect
  rendered behavior and test interactions. Only claim tests that were actually
  executed.
- **Screen reader:** Test with a real screen reader only when appropriate tools and
  controls are available. An accessibility tree or code inspection is not a
  screen-reader test.
- If a tool is unavailable, continue with feasible methods; do not fabricate its
  output.

### 3. Conduct a systematic audit

1. **Automated checks, when available:** Use WAVE or an equivalent tool; review
   errors, contrast flags, and alerts. Validate each relevant result rather than
   assuming all automated flags are failures. Do not modify the product unless
   explicitly asked to fix it.
2. **Keyboard tests, when live interaction is available:** Complete critical tasks
   without a pointer. Use Tab/Shift+Tab, Enter, Space, arrow keys, and Escape where
   applicable; assess reachability, logical focus order, focus visibility,
   operation, and unexpected traps.
3. **Assistive-technology tests, when available:** Check accessible
   names/roles/states, reading and announcement order, form feedback, and dynamic
   updates with the actual tool used. Name the assistive technology and test
   conditions.
4. **Other relevant checks:** Based on input and tool access, assess
   resizing/reflow, non-text content, semantics, captions/transcripts, page
   language/title, target size, timing/motion controls, and error identification.
   Cover applicable WCAG A and AA criteria, not just common examples.

When conducting the audit and verifying WCAG criteria, consult the bundled
[references/wcag-checklist.md](references/wcag-checklist.md) — a practical
per-criterion aid mapping each WCAG 2.2 A/AA success criterion to what to check,
how to verify, and an example issue. Consult the official
[WCAG 2.2 standard](https://www.w3.org/TR/WCAG22/) and
[WCAG Quick Reference](https://www.w3.org/WAI/WCAG22/quickref/) when interpreting
or mapping success criteria; do not invent criterion numbers or requirements.

### 4. Apply the mandatory evidence gate and conservative reporting policy

Prioritize accuracy over the number of findings. False accessibility findings
lead to unnecessary remediation and reduce trust in the audit. When uncertain
whether an issue qualifies, prefer excluding it from the findings table and
documenting a relevant testing limitation or coverage gap instead. Zero findings
is a valid audit result.

Before adding any item to the findings table, answer these questions internally.
Use them to decide whether an issue qualifies as a finding; do not add them as
separate columns in the report. Record the supporting evidence and any relevant
contradictions in the finding's Evidence field.

1. What specific accessibility barrier is observable in the supplied evidence?
2. What evidence supports suspecting this barrier?
3. Does any available evidence contradict the suspected issue?
4. Can the applicable WCAG criterion be evaluated using the available input?

Decision rules:

- Require specific, observable evidence suggesting an accessibility barrier; if no
  specific barrier is observable, do not create a finding.
- Reject findings contradicted by available evidence, including existing visual or
  textual cues.
- Do not treat unknown implementation details as suspected failures, and do not
  turn every unmeasured property into a potential WCAG violation.
- If the concern is observable but requires additional measurement or interactive
  testing, and the observation provides a reasonable basis for further
  investigation, label it "Needs Verification" and identify the required test.
- If the criterion cannot be meaningfully evaluated from the supplied input, or a
  concern depends entirely on unavailable code or interactive behavior, exclude it
  from the findings table and place the relevant test under Coverage Gaps; mention
  it there only when relevant.
- Use "Undetermined" severity when the evidence does not support a meaningful
  impact assessment.

Screenshot-only restrictions:

- Do not report missing accessible names, roles, states, semantic markup, alt text,
  keyboard support, or screen-reader compatibility based solely on screenshots.
- Do not report missing focus indicators unless the screenshot captures a focused
  state.
- Do not report repeated link text as a WCAG failure without evidence about the
  programmatic context.
- Do not create findings merely because a control, image, or heading exists.
- An empty findings table is acceptable when no evidence-supported concerns are
  identified.

### 5. Record evidence and report findings

- Create a spreadsheet-style findings table by default; generate a spreadsheet file
  only if requested and supported by available tools.
- Group repeated problems into a single finding, and enumerate affected
  pages/components actually observed. Keep distinct root causes separate.
- For each finding, include:
  - Issue ID and concise issue description
  - Affected page(s), component(s), and state(s)
  - Testing method and user impact
  - Severity: Critical (essential task blocked, no accessible workaround), High
    (major barrier), Medium (meaningful difficulty), Low (limited impact), or
    Undetermined (evidence does not support a meaningful impact assessment)
  - Evidence (observed behavior, code excerpt, tool result, or screenshot reference)
  - Status: Confirmed or Needs Verification
  - Applicable WCAG 2.2 success criterion number, name, and A/AA level, if
    substantiated
  - Actionable recommended fix
- Label suspected issues requiring measurement or interactive testing Needs
  Verification; describe the exact follow-up test. Do not present them as confirmed
  WCAG failures.
- Do not invent findings merely because a class of tests was unavailable. Record
  test limitations separately, briefly.
- Base severity and prioritization on observed evidence and the actual user impact
  of what was examined, never on hypothetical or worst-case failures. If a barrier
  cannot be substantiated with the available input, mark it Needs Verification and
  do not assign a severity that assumes the failure is confirmed.

### 6. Quality-check the final report

- Ensure each finding has specific evidence and the status reflects what was
  actually observed.
- Validate evidence before listing a finding. Distinguish issues actually observed
  in the available input from aspects that cannot be evaluated with it; keep the
  latter out of the findings table and record them under test limitations or
  coverage gaps instead. Do not enter unsupported assumptions as findings, and
  check whether visible evidence contradicts a suspected issue (for example, a cue
  that is present after all, or sufficient apparent contrast) before reporting it —
  if contradicted, drop or correct the finding.
- Verify WCAG mappings and distinguish criterion conformance level from severity.
- Confirm suggested fixes address the observed barrier, and avoid duplicate findings.
- Summarize tested scope, tools used, confirmed issues, potential issues, priority
  remediation themes, and limitations.
- Do not claim a full WCAG conformance certification from screenshots, automation
  alone, or a representative sample.

## Output format

Begin with a short **Audit summary** (scope, methods, limitations, counts by
status/severity). Follow with a **Findings table** using the columns above, then
**Priority recommendations** and a brief **Needs verification / coverage gaps**
note as appropriate. Keep technical details precise enough for design and
engineering handoff.
