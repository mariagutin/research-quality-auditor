// CI unit tests for the two MVP quotation-verification BDD scenarios.
//
// These exercise the PURE analysis function `analyzeReport` with in-memory report
// and transcript text. They touch NO database, Storage, Docker, network, or env —
// so they run fast in GitHub Actions on every push (just `npm ci` + `tsx`).
// Importing `run-check` is side-effect-free: it only pulls in the pure text-compare
// helpers and a type-only Supabase import; no client is created at import time.
//
//   npm run test:unit   (→ tsx scripts/ci/quotation-scenarios.test.mts)
//
// Requirements covered: TR-08 (wording + participant identity), TR-09 / NFR-04
// (verbatim evidence, nothing invented, a no-match result), and the wording-
// difference threshold from ADR-0006 (near-match ≥ 0.70 similarity AND ≥ 4 words).

import { analyzeReport } from "../../lib/reviews/run-check";

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) {
    console.log(`PASS: ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL: ${name} ${extra}`);
  }
}

// ---------------------------------------------------------------------------
// Scenario 1 — incorrect participant credit (participant mismatch).
// Given the report credits a quotation to P03, but the exact quotation appears
// only in P05's transcript, When the check runs, Then it flags a participant
// mismatch and shows P05's transcript passage + source document.
// ---------------------------------------------------------------------------
{
  const res = analyzeReport({
    reportDocumentId: "report-doc",
    reportText: 'P03 said, "the dashboard saved me time."',
    transcripts: [
      { documentId: "t-p03", participantId: "P03", text: "P03: nothing relevant here.\n" },
      { documentId: "t-p05", participantId: "P05", text: "P05: the dashboard saved me time.\n" },
    ],
  });
  const q = res[0];
  check("S1: exactly one quotation", res.length === 1, JSON.stringify(res));
  check("S1: credited participant recorded as P03", q?.listed_participant_id === "P03", JSON.stringify(q));
  check("S1: flagged has_issues", q?.checking_result === "has_issues", JSON.stringify(q));
  check("S1: matched the ACTUAL speaker P05's transcript", q?.matched_document_id === "t-p05", JSON.stringify(q));
  check("S1: a single participant_mismatch issue", q?.issues?.length === 1 && q?.issues?.[0]?.issue_type === "participant_mismatch", JSON.stringify(q));
  check(
    "S1: evidence is P05's passage + source document",
    q?.issues?.[0]?.source_document_id === "t-p05" &&
      q?.issues?.[0]?.source_excerpt === "P05: the dashboard saved me time.",
    JSON.stringify(q?.issues?.[0]),
  );
}

// ---------------------------------------------------------------------------
// Scenario 2 — quotation not found.
// Given a report quotation with no exact or sufficiently close (≥ 0.70 / ≥ 4 words)
// match in any transcript, When the check runs, Then it flags "Quote not found"
// WITHOUT inventing or displaying a supporting source passage.
// ---------------------------------------------------------------------------
{
  const res = analyzeReport({
    reportDocumentId: "report-doc",
    reportText: 'The study notes, "a statement that is not present in any transcript at all."',
    transcripts: [
      { documentId: "t-p03", participantId: "P03", text: "P03: I thought the onboarding was clear.\n" },
    ],
  });
  const q = res[0];
  check("S2: exactly one quotation", res.length === 1, JSON.stringify(res));
  check("S2: flagged has_issues", q?.checking_result === "has_issues", JSON.stringify(q));
  check("S2: issue is quote_not_found (not a wording difference)", q?.issues?.length === 1 && q?.issues?.[0]?.issue_type === "quote_not_found", JSON.stringify(q));
  check(
    "S2: NO source passage shown (nothing invented)",
    q?.matched_document_id === null &&
      q?.matched_excerpt === null &&
      !q?.issues?.[0]?.source_document_id &&
      !q?.issues?.[0]?.source_excerpt,
    JSON.stringify(q),
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nALL QUOTATION-SCENARIO CHECKS PASSED");
