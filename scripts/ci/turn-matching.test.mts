// CI unit tests for full-turn parsing, speaker boundaries, moderator exclusion,
// ordinary colons, shorter source passages, the fitting-alignment candidate window,
// and the distant-word regression. All PURE: analyzeReport + the pure helpers,
// in-memory, no DB/Storage/Docker/network/env -- so they run in GitHub Actions on
// every push (npm run test:unit). Behaviour recorded in ADR-0006.

import { analyzeReport } from "../../lib/reviews/run-check";
import { findConflictingSpeakerLabel } from "../../lib/reviews/finish-save";
import { bestWindow, wordNorms } from "../../lib/reviews/text-compare";

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) {
    console.log(`PASS: ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL: ${name} ${extra}`);
  }
}

const report = (quote: string) => `The study reports, "${quote}"`;
const one = (reportText: string, docId: string, participantId: string, text: string) =>
  analyzeReport({ reportDocumentId: "report-doc", reportText, transcripts: [{ documentId: docId, participantId, text }] })[0];

// 1. Exact match that lives ONLY on a continuation line (no label of its own).
{
  const q = one(report("The dashboard saved me time."), "t", "P05", "P05: Let me think.\nThe dashboard saved me time.\n");
  check("continuation-line exact -> no_issues", q?.checking_result === "no_issues", JSON.stringify(q));
  check("continuation-line evidence is the FULL turn", (q?.matched_excerpt ?? "").includes("Let me think") && (q?.matched_excerpt ?? "").includes("saved me time"), JSON.stringify(q?.matched_excerpt));
}

// 2. Exact match that spans the label line -> continuation line break.
{
  const q = one(report("slow at first, then it saved me time"), "t", "P05", "P05: it was slow at first,\nthen it saved me time.\n");
  check("quote spanning the line break -> no_issues", q?.checking_result === "no_issues", JSON.stringify(q));
}

// 3a. A DIFFERENT participant label ends the turn: its words are not P05's speech.
{
  const q = one(report("the dashboard was great and the export was slow"), "t", "P05", "P05: the dashboard was great\nP03: and the export was slow\n");
  check("different-speaker label ends the turn -> quote_not_found", q?.issues?.[0]?.issue_type === "quote_not_found", JSON.stringify(q));
}
// 3b. The SAME participant starting again ends the turn (two separate turns). The
//     quote spans both and matches NEITHER half alone (even split, each < 0.70), so
//     it would only match if the turns were wrongly merged.
{
  const q = one(report("the dashboard really saved me a lot of extra time"), "t", "P05", "P05: the dashboard really saved me\nP05: a lot of extra time\n");
  check("same-speaker re-label ends the turn -> quote_not_found", q?.issues?.[0]?.issue_type === "quote_not_found", JSON.stringify(q));
}

// 4a. Moderator speech is excluded from participant matching.
{
  const q = one(report("did the dashboard save you time"), "t", "P05", "Moderator: did the dashboard save you time?\nP05: not really, it was slow.\n");
  check("moderator label line excluded -> quote_not_found", q?.issues?.[0]?.issue_type === "quote_not_found", JSON.stringify(q));
}
// 4b. A moderator CONTINUATION line is excluded too.
{
  const q = one(report("the dashboard felt fast enough"), "t", "P05", "Moderator: a few things --\nthe dashboard felt fast enough?\nP05: yes, mostly.\n");
  check("moderator continuation line excluded -> quote_not_found", q?.issues?.[0]?.issue_type === "quote_not_found", JSON.stringify(q));
}

// 5. An ordinary colon ("First:") does not start a new turn.
{
  const q = one(report("onboarding was rough"), "t", "P05", "P05: I had two notes.\nFirst: onboarding was rough. Second: export was slow.\n");
  check("ordinary colon is NOT a speaker label -> no_issues", q?.checking_result === "no_issues", JSON.stringify(q));
  check("ordinary-colon turn kept whole", (q?.matched_excerpt ?? "").includes("First:") && (q?.matched_excerpt ?? "").includes("Second:"), JSON.stringify(q?.matched_excerpt));
}

// 6. A four-word quotation may match a THREE-word source passage (no window floor).
{
  const q = one(report("the dashboard saved time"), "t", "P05", "P05: dashboard saved time.\n");
  check("4-word quote vs 3-word source -> wording_mismatch", q?.issues?.length === 1 && q?.issues?.[0]?.issue_type === "wording_mismatch", JSON.stringify(q));
}

// 7. Distant-word regression: a stray matching word far away must NOT stretch the
//    candidate or sink the score. The nearby "The dashboard saved hours" should win.
{
  const turn =
    "P05: The dashboard saved hours.\n" +
    "We tried a number of other things that did not matter here and talked for a while.\n" +
    "Next time, I'll try exporting.\n";
  const q = one(report("The dashboard saved time."), "t", "P05", turn);
  check("distant-word case -> wording_mismatch (not quote_not_found)", q?.issues?.[0]?.issue_type === "wording_mismatch", JSON.stringify(q?.issues));
  // The fitting window selects the nearby passage, keeping the time<->hours substitution.
  const win = bestWindow(wordNorms("The dashboard saved time."), wordNorms("The dashboard saved hours. We tried a number of other things that did not matter here and talked for a while. Next time, I'll try exporting."));
  const words = wordNorms("The dashboard saved hours. We tried a number of other things that did not matter here and talked for a while. Next time, I'll try exporting.");
  const picked = win ? words.slice(win.start, win.end + 1).join(" ") : "";
  check("fitting window is the nearby passage incl. 'hours'", picked === "the dashboard saved hours", `picked=${JSON.stringify(picked)} score=${win?.score?.toFixed(3)}`);
}

// 8. Pure speaker-label conflict validation (the upload safeguard).
{
  check("validation accepts P05 + Moderator", findConflictingSpeakerLabel("P05: hi there.\nModerator: a question?\nP05: bye.", "P05") === null);
  check("validation rejects a stray P03", findConflictingSpeakerLabel("P05: hi there.\nP03: oops I am here too.", "P05") === "P03");
  check("validation ignores ordinary colons", findConflictingSpeakerLabel("P05: well, here's the thing: ok.\nHonestly: fine.", "P05") === null);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nALL TURN-MATCHING CHECKS PASSED");
