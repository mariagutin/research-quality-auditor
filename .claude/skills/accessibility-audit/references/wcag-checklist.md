# WCAG 2.2 Level A and AA — Practical Audit Checklist

Companion reference for `.claude/skills/accessibility-audit/SKILL.md`. This is an
audit aid, not a substitute for the normative WCAG text.

Sources: [WCAG 2.2 standard](https://www.w3.org/TR/WCAG22/) ·
[WCAG 2.2 Quick Reference](https://www.w3.org/WAI/WCAG22/quickref/)

## Using the checklist

- Select applicable criteria for tested pages, components, states, and complete
  processes; document coverage and exceptions.
- Use tools according to available evidence; a screenshot cannot establish keyboard
  or screen-reader behavior.
- For each observed concern, capture evidence and the method used. Mark as
  **Confirmed** only if the evidence supports the failure; otherwise
  **Needs Verification**, with a specific follow-up test.
- Automated alerts are leads, not conclusive failures. Do not claim a real
  screen-reader test from an accessibility tree.
- A and AA are conformance levels, not severity. The priority/severity of findings
  depends on user impact.
- Some success criteria are not applicable to a specific page or process. Do not
  invent violations for missing features.
- WCAG 2.2 removed 4.1.1 Parsing; do not list it as a WCAG 2.2 A/AA success criterion.

Methods are indicative, not a guarantee that the criterion can be verified with a
given input. Respect exceptions, definitions, and applicability in the normative
standard.

## 1. Perceivable

| Success criterion | Level | What to check | Suggested verification | Example issue |
|---|---|---|---|---|
| 1.1.1 Non-text Content | A | Meaningful images and controls have equivalent text; decoration is ignored | Code + context; AT where available | Informative chart with no text alternative |
| 1.2.1 Audio-only and Video-only (Prerecorded) | A | Equivalent alternative for prerecorded audio-only or silent video | Media review + alternative review | Podcast lacks equivalent transcript |
| 1.2.2 Captions (Prerecorded) | A | Prerecorded synchronized video includes accurate captions | Play media and inspect captions | Instructional video has no captions |
| 1.2.3 Audio Description or Media Alternative (Prerecorded) | A | Visual-only information in prerecorded video has an appropriate alternative | Watch with audio only; inspect alternative | Critical on-screen instructions not conveyed |
| 1.2.4 Captions (Live) | AA | Live synchronized media provides captions | Observe live stream/caption service | Live event has no captions |
| 1.2.5 Audio Description (Prerecorded) | AA | Relevant visual information in prerecorded video is conveyed by audio description | Review video and audio description | Important visual action never described |
| 1.3.1 Info and Relationships | A | Structure and relationships are programmatically determinable | Code/DOM + accessibility tree + AT | Visual label not associated with input |
| 1.3.2 Meaningful Sequence | A | Reading order preserves intended meaning | DOM reading order + AT where available | CSS layout yields misleading reading order |
| 1.3.3 Sensory Characteristics | A | Instructions do not rely only on shape, location, sound, or other sensory cues | Content review | "Press the round button on the right" only |
| 1.3.4 Orientation | AA | Content does not force one display orientation unless essential | Rotate mobile viewport/device | Form works only in portrait without essential reason |
| 1.3.5 Identify Input Purpose | AA | Common personal-data fields expose correct programmatic purposes where applicable | Inspect autocomplete semantics | Email field lacks appropriate autocomplete token |
| 1.4.1 Use of Color | A | Color is not the only way to convey meaning or identify actions | Visual + content review | Required fields indicated only in red |
| 1.4.2 Audio Control | A | Auto-playing audio lasting >3 seconds can be paused/stopped or independently controlled | Live media interaction | Background sound cannot be stopped |
| 1.4.3 Contrast (Minimum) | AA | Text meets applicable contrast thresholds (typically 4.5:1; large text 3:1), subject to exceptions | Measure foreground/background colors | Placeholder/label contrast measures below threshold |
| 1.4.4 Resize Text | AA | Text can enlarge to 200% without loss of content/functionality (within criterion scope) | Live zoom/text resize | Enlarged labels disappear or overlap |
| 1.4.5 Images of Text | AA | Actual text is used instead of images of text except permitted cases | Visual + code review | Paragraph rendered as a raster image unnecessarily |
| 1.4.10 Reflow | AA | At relevant narrow viewport/zoom, content reflows without two-dimensional scrolling except permitted content | Live viewport/zoom (e.g., 320 CSS px equivalent) | Reading a paragraph requires horizontal scrolling |
| 1.4.11 Non-text Contrast | AA | Required visual boundaries/states and meaningful graphics meet applicable 3:1 contrast | Measure rendered colors | Input border needed to identify field is too faint |
| 1.4.12 Text Spacing | AA | Increasing line, paragraph, letter, and word spacing to specified values does not lose content/function | Apply text-spacing overrides live | Text clips when spacing increases |
| 1.4.13 Content on Hover or Focus | AA | Additional content triggered by hover/focus is dismissible, hoverable, and persistent when required | Live mouse + keyboard tests | Tooltip vanishes when pointer moves into it |

## 2. Operable

| Success criterion | Level | What to check | Suggested verification | Example issue |
|---|---|---|---|---|
| 2.1.1 Keyboard | A | Functionality can be operated with keyboard except allowed exceptions | Live keyboard walkthrough | Menu opens only on mouse hover |
| 2.1.2 No Keyboard Trap | A | Focus can leave components with keyboard, using documented escape where needed | Live keyboard navigation | Focus cannot leave custom widget |
| 2.1.4 Character Key Shortcuts | A | Single-character shortcuts can be disabled/remapped or require focus | Code + live shortcut tests | Typing a letter triggers action while focus is elsewhere |
| 2.2.1 Timing Adjustable | A | Time limits allow qualifying adjustment/extension/turnoff unless an exception applies | Live timed workflow | Form expires abruptly without extension option |
| 2.2.2 Pause, Stop, Hide | A | Moving, auto-updating, blinking or scrolling content offers required control | Live observation + controls | Auto-rotating carousel cannot be paused |
| 2.3.1 Three Flashes or Below Threshold | A | Content avoids flashes above applicable threshold | Inspect animation/video with suitable analysis | Rapid flashing animation above threshold |
| 2.4.1 Bypass Blocks | A | Users can bypass repeated content blocks | Code + keyboard test | No way past long repeated navigation |
| 2.4.2 Page Titled | A | Page has descriptive title reflecting purpose/topic | Inspect document title | Every page has title "Untitled" |
| 2.4.3 Focus Order | A | Sequential focus order preserves meaning and operation | Live Tab/Shift+Tab | Focus jumps unpredictably across form |
| 2.4.4 Link Purpose (In Context) | A | Link purpose is clear from its text or programmatically determined context | Code + AT link review | Several ambiguous "Click here" links |
| 2.4.5 Multiple Ways | AA | More than one method locates pages in a set, with stated exceptions | Site navigation review | Only one way to reach ordinary content page |
| 2.4.6 Headings and Labels | AA | Headings and labels describe topic or purpose | Content + code review | Multiple form fields labeled only "Input" |
| 2.4.7 Focus Visible | AA | Keyboard focus has a visible indicator | Live keyboard test | CSS removes focus outline without replacement |
| 2.4.11 Focus Not Obscured (Minimum) | AA | Focused component is not entirely hidden by author-created content | Live keyboard + sticky headers/overlays | Sticky footer completely hides focused button |
| 2.5.1 Pointer Gestures | A | Multipoint/path gestures offer single-pointer alternatives unless essential | Touch/pointer interaction | Only pinch gesture controls essential action |
| 2.5.2 Pointer Cancellation | A | Pointer actions satisfy down/up/abort/undo requirements | Live pointer tests | Dangerous action commits on pointer-down with no undo |
| 2.5.3 Label in Name | A | Visible label text is included in programmatic accessible name | Code/accessibility tree + visual check | Button visibly says "Save" but name is "Submit" |
| 2.5.4 Motion Actuation | A | Motion-based features have UI alternatives and can be disabled when required | Device/live interaction | Shake-to-undo has no on-screen alternative |
| 2.5.7 Dragging Movements | AA | Dragging functions also support a single-pointer non-drag alternative unless essential | Live pointer/touch test | Reordering items requires drag only |
| 2.5.8 Target Size (Minimum) | AA | Pointer targets meet 24×24 CSS px sizing or a specified exception (e.g., spacing) | Rendered measurement + target geometry | Small tightly packed icon buttons without sufficient spacing |

## 3. Understandable

| Success criterion | Level | What to check | Suggested verification | Example issue |
|---|---|---|---|---|
| 3.1.1 Language of Page | A | Default page language is programmatically identified | Inspect html lang / document language | English page has no language declaration |
| 3.1.2 Language of Parts | AA | Passages with different human language are identified where required | Code + AT review | Long French passage is unmarked on English page |
| 3.2.1 On Focus | A | Focus alone does not unexpectedly change context | Live keyboard test | Tabbing to select immediately redirects page |
| 3.2.2 On Input | A | Changing form input does not unexpectedly change context without advance notice | Live form interaction | Selecting option instantly submits without warning |
| 3.2.3 Consistent Navigation | AA | Repeated navigation appears in consistent relative order | Compare multiple pages | Primary navigation rearranged without reason |
| 3.2.4 Consistent Identification | AA | Same-function components are consistently identified | Compare pages/components | Same icon has conflicting accessible labels |
| 3.2.6 Consistent Help | A | Help mechanisms repeated across pages stay in consistent relative order | Compare pages with help | Support link moves unpredictably across pages |
| 3.3.1 Error Identification | A | Detected input errors are identified and described in text | Submit invalid data + inspect feedback | Error shown only as red border |
| 3.3.2 Labels or Instructions | A | Inputs have labels/instructions when user input is required | Code + visual/form review | Field has no identifiable purpose |
| 3.3.3 Error Suggestion | AA | When known, correction suggestions are provided unless doing so harms security/purpose | Invalid-form workflow | Date error gives no actionable correction |
| 3.3.4 Error Prevention (Legal, Financial, Data) | AA | Covered high-stakes submissions allow reversibility, review/correction, or checking | Complete high-stakes workflow | Irreversible financial submission lacks review |
| 3.3.7 Redundant Entry | A | Previously supplied information need not be re-entered in same process except permitted exceptions | Multi-step flow | Repeated address entry required without reason |
| 3.3.8 Accessible Authentication (Minimum) | AA | Authentication avoids cognitive-function tests without permitted assistance/alternatives | Authentication walkthrough | Must memorize and transcribe password without support |

## 4. Robust

| Success criterion | Level | What to check | Suggested verification | Example issue |
|---|---|---|---|---|
| 4.1.2 Name, Role, Value | A | UI components expose correct names, roles, states, values and changes | Code + accessibility tree + AT/live when available | Custom checkbox never exposes checked state |
| 4.1.3 Status Messages | AA | Relevant status messages can be determined programmatically without receiving focus | Live interaction + accessibility tree/AT | "Saved" update is not announced |

## Coverage and validation notes

- Record **Not applicable** only when justified; record **Not tested** when applicable
  but outside scope or tools. Neither means a pass.
- Check that mobile, zoom/reflow, interactive states, errors, and time-based media are
  represented when relevant.
- Validate threshold values, exceptions, and criterion interpretations against the W3C
  standard before asserting conformance failures.
- Screen-reader output and keyboard operability require actual suitable testing access;
  source code can identify implementation concerns but does not automatically verify
  end-user behavior.
- Audit results from representative samples must not be generalized into a whole-site
  conformance claim.
