// Local integration test for lib/reviews/run-check.ts.
//
// LOCAL, disposable Supabase stack ONLY. It runs the pure analysis on synthetic
// text, then a full runReviewCheck against the local stack (creates a synthetic
// user, uploads synthetic .md files, runs the check, asserts the saved rows),
// and cleans up after itself.
//
// Run from the repo root (keys are auto-resolved from `supabase status`; or set
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY yourself):
//
//   npx tsx scripts/run-check.local-test.mts
//
// Prereqs: Docker running and `npx supabase start` up, with migrations applied
// (`npx supabase db reset` or `npx supabase migration up`). A clean run prints
// PASS lines and ends with "ALL CHECKS PASSED" (exit 0); any failure exits 1.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { analyzeReport, runReviewCheck, REVIEW_FILES_BUCKET } from "../lib/reviews/run-check";

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) console.log(`PASS: ${name}`);
  else {
    failures += 1;
    console.error(`FAIL: ${name} ${extra}`);
  }
}

function resolveLocalConfig(): { url: string; anon: string; service: string } {
  let url = process.env.SUPABASE_URL;
  let anon = process.env.SUPABASE_ANON_KEY;
  let service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anon || !service) {
    try {
      const out = execSync("npx supabase status -o json", {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const s = JSON.parse(out);
      url = url || s.API_URL;
      anon = anon || s.ANON_KEY;
      service = service || s.SERVICE_ROLE_KEY;
    } catch {
      /* fall through to the error below */
    }
  }
  if (!url || !anon || !service) {
    console.error(
      "Could not resolve local Supabase keys. Start the local stack " +
        "(`npx supabase start`) or set SUPABASE_URL / SUPABASE_ANON_KEY / " +
        "SUPABASE_SERVICE_ROLE_KEY.",
    );
    process.exit(2);
  }
  return { url, anon, service };
}

const T_DOC = "transcript-doc-id";

// ---------------- Pure analysis (no network) ----------------

// A: wording match in a participant line, attributed "as P03 put it".
{
  const report = `# Report\n\nAs P03 put it, "I loved how simple the setup was."\n`;
  const res = analyzeReport({
    reportDocumentId: "report-doc",
    reportText: report,
    transcripts: [
      { documentId: T_DOC, participantId: "P03", text: "Moderator: How was setup?\nP03: I loved how simple the setup was.\n" },
    ],
  });
  check("A: one quotation", res.length === 1, JSON.stringify(res));
  const q = res[0];
  check("A: wording matched (no_issues)", q.checking_result === "no_issues", JSON.stringify(q));
  check("A: matched the transcript", q.matched_document_id === T_DOC, JSON.stringify(q));
  check("A: excerpt is the whole participant line", q.matched_excerpt === "P03: I loved how simple the setup was.", JSON.stringify(q));
  check("A: attribution P03", q.listed_participant_id === "P03", JSON.stringify(q));
  check("A: offsets slice back to the quote", Array.from(report).slice(q.start_offset, q.end_offset).join("") === "I loved how simple the setup was.", `${q.start_offset},${q.end_offset}`);
}
// B: phrase only in a Moderator line -> no match.
{
  const res = analyzeReport({
    reportDocumentId: "report-doc",
    reportText: `P03 said, "Thanks for joining today."`,
    transcripts: [{ documentId: T_DOC, participantId: "P03", text: "Moderator: Thanks for joining today.\nP03: Happy to be here.\n" }],
  });
  check("B: has_issues (moderator excluded)", res[0]?.checking_result === "has_issues", JSON.stringify(res));
  check("B: no evidence", res[0]?.matched_document_id === null, JSON.stringify(res));
  check("B: quote_not_found issue", res[0]?.issues?.[0]?.issue_type === "quote_not_found", JSON.stringify(res));
}
// C: absent phrase -> no match.
{
  const res = analyzeReport({
    reportDocumentId: "report-doc",
    reportText: `The study noted, "A phrase that appears nowhere."`,
    transcripts: [{ documentId: T_DOC, participantId: "P03", text: "P03: Something else entirely.\n" }],
  });
  check("C: has_issues (absent)", res[0]?.checking_result === "has_issues", JSON.stringify(res));
}
// D: attribution empty on mere co-occurrence.
{
  const res = analyzeReport({
    reportDocumentId: "report-doc",
    reportText: `The onboarding that P03 and others used was praised: "it was simple."`,
    transcripts: [{ documentId: T_DOC, participantId: "P03", text: "P03: it was simple.\n" }],
  });
  check("D: co-occurrence -> attribution empty", res[0]?.listed_participant_id === null, JSON.stringify(res));
  check("D: still wording-matched", res[0]?.checking_result === "no_issues", JSON.stringify(res));
}
// E: code-point offsets with a multibyte char before the quote.
{
  const report = `😀 As P03 put it, "hello world."`;
  const res = analyzeReport({
    reportDocumentId: "report-doc",
    reportText: report,
    transcripts: [{ documentId: T_DOC, participantId: "P03", text: "P03: hello world.\n" }],
  });
  const q = res[0];
  check("E: code-point slice equals quote", Array.from(report).slice(q.start_offset, q.end_offset).join("") === "hello world.", `${q.start_offset},${q.end_offset}`);
  check("E: start uses code points, not UTF-16", q.start_offset === 18, String(q.start_offset));
}

// F: attribution on the line directly ABOVE the quote (our saved sample shape).
{
  const report = `Participants were positive. As P03 put it,\n"I loved how simple the setup was."\n`;
  const res = analyzeReport({
    reportDocumentId: "report-doc",
    reportText: report,
    transcripts: [{ documentId: T_DOC, participantId: "P03", text: "Moderator: How was setup?\nP03: I loved how simple the setup was.\n" }],
  });
  check("F: line-above attribution -> P03", res[0]?.listed_participant_id === "P03", JSON.stringify(res));
  check("F: still wording-matched", res[0]?.checking_result === "no_issues", JSON.stringify(res));
}
// G: an unrelated participant MENTION (not a speaker attribution) -> empty.
{
  const res = analyzeReport({
    reportDocumentId: "report-doc",
    reportText: `Feedback from the P03 session was positive:\n"it was simple."`,
    transcripts: [{ documentId: T_DOC, participantId: "P03", text: "P03: it was simple.\n" }],
  });
  check("G: unrelated mention -> empty", res[0]?.listed_participant_id === null, JSON.stringify(res));
}
// H: two confirmed IDs both attributing -> ambiguous -> empty.
{
  const res = analyzeReport({
    reportDocumentId: "report-doc",
    reportText: `P03 said it was fine and P05 added,\n"it was simple."`,
    transcripts: [
      { documentId: "t-p03", participantId: "P03", text: "P03: something else.\n" },
      { documentId: "t-p05", participantId: "P05", text: "P05: it was simple.\n" },
    ],
  });
  check("H: ambiguous IDs -> empty", res[0]?.listed_participant_id === null, JSON.stringify(res));
}
// I: attribution separated from the quote by a BLANK line -> empty.
{
  const res = analyzeReport({
    reportDocumentId: "report-doc",
    reportText: `As P03 put it,\n\n"I loved how simple the setup was."`,
    transcripts: [{ documentId: T_DOC, participantId: "P03", text: "P03: I loved how simple the setup was.\n" }],
  });
  check("I: blank-line separation -> empty", res[0]?.listed_participant_id === null, JSON.stringify(res));
  check("I: still wording-matched", res[0]?.checking_result === "no_issues", JSON.stringify(res));
}
// J: attribution two lines up (line directly above is unrelated) -> empty.
{
  const res = analyzeReport({
    reportDocumentId: "report-doc",
    reportText: `As P03 put it,\nThe report then states,\n"I loved how simple the setup was."`,
    transcripts: [{ documentId: T_DOC, participantId: "P03", text: "P03: I loved how simple the setup was.\n" }],
  });
  check("J: farther-back attribution -> empty", res[0]?.listed_participant_id === null, JSON.stringify(res));
}

// Attribution verification -----------------------------------------------
const TWO = [
  { documentId: "t-p03", participantId: "P03", text: "" },
  { documentId: "t-p05", participantId: "P05", text: "" },
];

// K: report names P03, quote is in P03's speech -> verified, no issue.
{
  const res = analyzeReport({
    reportDocumentId: "rd",
    reportText: `P03 said, "verified quote."`,
    transcripts: [
      { ...TWO[0], text: "P03: verified quote.\n" },
      { ...TWO[1], text: "P05: something else.\n" },
    ],
  });
  const q = res[0];
  check("K: verified -> no_issues", q?.checking_result === "no_issues", JSON.stringify(q));
  check("K: matched P03's transcript", q?.matched_document_id === "t-p03", JSON.stringify(q));
  check("K: no attribution issue", q?.issues === undefined, JSON.stringify(q));
}
// L: report names P03, quote only in P05's speech -> participant_mismatch + evidence.
{
  const res = analyzeReport({
    reportDocumentId: "rd",
    reportText: `P03 said, "only p05 said this."`,
    transcripts: [
      { ...TWO[0], text: "P03: nothing relevant.\n" },
      { ...TWO[1], text: "P05: only p05 said this.\n" },
    ],
  });
  const q = res[0];
  check("L: mismatch -> has_issues", q?.checking_result === "has_issues", JSON.stringify(q));
  check("L: matched the ACTUAL speaker P05", q?.matched_document_id === "t-p05", JSON.stringify(q));
  check("L: participant_mismatch issue", q?.issues?.[0]?.issue_type === "participant_mismatch", JSON.stringify(q));
  check("L: issue source evidence set", q?.issues?.[0]?.source_document_id === "t-p05" && q?.issues?.[0]?.source_excerpt === "P05: only p05 said this.", JSON.stringify(q));
}
// M: no participant named, quote in P05's speech -> matched, NO attribution issue.
{
  const res = analyzeReport({
    reportDocumentId: "rd",
    reportText: `The report states: "shared wording here."`,
    transcripts: [
      { ...TWO[0], text: "P03: nothing.\n" },
      { ...TWO[1], text: "P05: shared wording here.\n" },
    ],
  });
  const q = res[0];
  check("M: unattributed -> no_issues", q?.checking_result === "no_issues", JSON.stringify(q));
  check("M: shows the source participant (P05)", q?.matched_document_id === "t-p05", JSON.stringify(q));
  check("M: attribution empty, no issue", q?.listed_participant_id === null && q?.issues === undefined, JSON.stringify(q));
}
// N: same wording in BOTH; report names P03 -> prefers P03 (verified, not mismatch).
{
  const res = analyzeReport({
    reportDocumentId: "rd",
    reportText: `P03 said, "both said this."`,
    transcripts: [
      { ...TWO[0], text: "P03: both said this.\n" },
      { ...TWO[1], text: "P05: both said this.\n" },
    ],
  });
  const q = res[0];
  check("N: prefers named participant P03", q?.matched_document_id === "t-p03" && q?.checking_result === "no_issues", JSON.stringify(q));
}
// O: same wording in both; report names P05 -> prefers P05.
{
  const res = analyzeReport({
    reportDocumentId: "rd",
    reportText: `P05 said, "both said this."`,
    transcripts: [
      { ...TWO[0], text: "P03: both said this.\n" },
      { ...TWO[1], text: "P05: both said this.\n" },
    ],
  });
  const q = res[0];
  check("O: prefers named participant P05", q?.matched_document_id === "t-p05" && q?.checking_result === "no_issues", JSON.stringify(q));
}
// P: report credits P03, but ONLY P05's transcript was uploaded (no P03 file).
//    The credit must still be detected and flagged as a participant mismatch,
//    not silently passed as "no issues". (Regression for the mm-report finding.)
{
  const res = analyzeReport({
    reportDocumentId: "rd",
    reportText: `P03 said, "the dashboard saved me time."`,
    transcripts: [
      { documentId: "t-p05", participantId: "P05", text: "P05: the dashboard saved me time.\n" },
    ],
  });
  const q = res[0];
  check("P: credit to transcript-less P03 detected", q?.listed_participant_id === "P03", JSON.stringify(q));
  check("P: flagged has_issues", q?.checking_result === "has_issues", JSON.stringify(q));
  check("P: matched the ACTUAL speaker P05", q?.matched_document_id === "t-p05", JSON.stringify(q));
  check("P: participant_mismatch issue", q?.issues?.[0]?.issue_type === "participant_mismatch", JSON.stringify(q));
}

// ---------------- Near (reworded) matching ----------------

// Q: reworded within the credited participant -> wording difference only.
{
  const res = analyzeReport({
    reportDocumentId: "rd",
    reportText: `P03 said, "the dashboard saved me time."`,
    transcripts: [{ documentId: "t-p03", participantId: "P03", text: "P03: the dashboard saved me a lot of time.\n" }],
  });
  const q = res[0];
  check("Q: has_issues (no exact match)", q?.checking_result === "has_issues", JSON.stringify(q));
  check("Q: matched the credited participant P03", q?.matched_document_id === "t-p03", JSON.stringify(q));
  check("Q: single wording_mismatch, no participant issue", q?.issues?.length === 1 && q?.issues?.[0]?.issue_type === "wording_mismatch", JSON.stringify(q));
}
// R: reworded only in ANOTHER participant -> participant_mismatch + wording_mismatch.
{
  const res = analyzeReport({
    reportDocumentId: "rd",
    reportText: `P03 said, "the dashboard saved me time."`,
    transcripts: [
      { documentId: "t-p03", participantId: "P03", text: "P03: nothing relevant here at all.\n" },
      { documentId: "t-p05", participantId: "P05", text: "P05: the dashboard saved me a lot of time.\n" },
    ],
  });
  const q = res[0];
  check("R: matched the other participant P05", q?.matched_document_id === "t-p05", JSON.stringify(q));
  const types = (q?.issues ?? []).map((i) => i.issue_type).sort();
  check("R: BOTH labels kept", JSON.stringify(types) === JSON.stringify(["participant_mismatch", "wording_mismatch"]), JSON.stringify(q));
  const pm = q?.issues?.find((i) => i.issue_type === "participant_mismatch");
  check("R: cautious attribution wording (no 'said by')", !!pm && /possible source passage/.test(pm.explanation ?? "") && !/was said by/.test(pm.explanation ?? ""), JSON.stringify(pm));
}
// S: negation is a wording difference and IS surfaced (meaning aside).
{
  const res = analyzeReport({
    reportDocumentId: "rd",
    reportText: `P05 said, "the tool was reliable."`,
    transcripts: [{ documentId: "t-p05", participantId: "P05", text: "P05: honestly the tool was not reliable.\n" }],
  });
  const q = res[0];
  check("S: negation flagged as wording difference", q?.checking_result === "has_issues" && q?.issues?.[0]?.issue_type === "wording_mismatch", JSON.stringify(q));
}
// T: a short reworded quote (< 4 words) is exact-only -> not flagged.
{
  const res = analyzeReport({
    reportDocumentId: "rd",
    reportText: `P05 said, "it worked."`,
    transcripts: [{ documentId: "t-p05", participantId: "P05", text: "P05: it failed.\n" }],
  });
  const q = res[0];
  check("T: short reworded quote -> quote_not_found", q?.issues?.[0]?.issue_type === "quote_not_found", JSON.stringify(q));
}
// U1: high lexical overlap but different meaning (4 words) -> surfaced to review.
{
  const res = analyzeReport({
    reportDocumentId: "rd",
    reportText: `P05 said, "it saved me time."`,
    transcripts: [{ documentId: "t-p05", participantId: "P05", text: "P05: it saved me money.\n" }],
  });
  const q = res[0];
  check("U1: 'time' vs 'money' (0.75) surfaced as possible wording difference", q?.issues?.[0]?.issue_type === "wording_mismatch", JSON.stringify(q));
}
// U2: the same swap at 3 words is below the minimum -> not flagged.
{
  const res = analyzeReport({
    reportDocumentId: "rd",
    reportText: `The report notes, "saved me time."`,
    transcripts: [{ documentId: "t-p05", participantId: "P05", text: "P05: saved me money.\n" }],
  });
  const q = res[0];
  check("U2: 3-word swap below minimum -> quote_not_found", q?.issues?.[0]?.issue_type === "quote_not_found", JSON.stringify(q));
}
// V: competing near candidates -> prefer the credited participant's passage,
//    even when another participant scores higher.
{
  const res = analyzeReport({
    reportDocumentId: "rd",
    reportText: `P03 said, "the dashboard saved me time."`,
    transcripts: [
      { documentId: "t-p03", participantId: "P03", text: "P03: the dashboard honestly saved me time anyway.\n" }, // ~0.83
      { documentId: "t-p05", participantId: "P05", text: "P05: the dashboard really saved me time.\n" }, // ~0.91
    ],
  });
  const q = res[0];
  check("V: prefers credited P03 despite P05 scoring higher", q?.matched_document_id === "t-p03", JSON.stringify(q));
  check("V: wording difference only (no participant issue)", q?.issues?.length === 1 && q?.issues?.[0]?.issue_type === "wording_mismatch", JSON.stringify(q));
}
// W: exact-match limitation -> an exact match in P05 takes priority over a near
//    match in the credited P03, so the selected passage may not be the source.
{
  const res = analyzeReport({
    reportDocumentId: "rd",
    reportText: `P03 said, "the dashboard saved me time."`,
    transcripts: [
      { documentId: "t-p03", participantId: "P03", text: "P03: the dashboard honestly saved me time anyway.\n" }, // near
      { documentId: "t-p05", participantId: "P05", text: "P05: the dashboard saved me time.\n" }, // exact
    ],
  });
  const q = res[0];
  check("W: exact P05 wins over near P03", q?.matched_document_id === "t-p05", JSON.stringify(q));
  check("W: single participant_mismatch, no wording issue", q?.issues?.length === 1 && q?.issues?.[0]?.issue_type === "participant_mismatch", JSON.stringify(q));
}

// ---------------- Full run against the local stack ----------------
async function integration() {
  const { url, anon, service } = resolveLocalConfig();
  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const email = `anna+${Date.now()}@synthetic.test`;
  const password = "synthetic-password-123";
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error || !created.data.user) throw new Error(`createUser: ${created.error?.message}`);
  const annaId = created.data.user.id;
  const anna = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const signin = await anna.auth.signInWithPassword({ email, password });
  if (signin.error) throw new Error(`signIn: ${signin.error.message}`);

  const reviewId = randomUUID();
  const reportDocId = randomUUID();
  const transcriptDocId = randomUUID();
  const base = `${annaId}/${reviewId}`;
  const uploaded: string[] = [];
  const up = async (path: string, content: string) => {
    const { error } = await (anna as SupabaseClient).storage
      .from(REVIEW_FILES_BUCKET)
      .upload(path, new Blob([content], { type: "text/markdown" }), { upsert: false });
    if (error) throw new Error(`upload ${path}: ${error.message}`);
    uploaded.push(path);
  };

  try {
    await anna.from("reviews").insert({ id: reviewId, user_id: annaId, name: "report" });
    await anna.from("documents").insert([
      { id: reportDocId, review_id: reviewId, user_id: annaId, role: "report", filename: "report.md", storage_path: `${base}/report.md` },
      { id: transcriptDocId, review_id: reviewId, user_id: annaId, role: "transcript", filename: "p03.md", storage_path: `${base}/p03.md`, participant_id: "P03" },
    ]);
    await up(`${base}/report.md`, `As P03 put it, "I loved how simple the setup was."\n`);
    await up(`${base}/p03.md`, `Moderator: How was setup?\nP03: I loved how simple the setup was.\n`);

    const res = await runReviewCheck(anna, annaId, reviewId);
    check("INT: runReviewCheck complete", res.status === "complete", JSON.stringify(res));
    check("INT: one quotation", res.status === "complete" && res.quotations === 1, JSON.stringify(res));

    const { data: qs } = await anna
      .from("quotations")
      .select("original_text, checking_result, matched_document_id, matched_excerpt, listed_participant_id")
      .eq("review_id", reviewId);
    check("INT: one quotation persisted", (qs?.length ?? 0) === 1, JSON.stringify(qs));
    const q = qs?.[0];
    check("INT: persisted as wording-matched with evidence", q?.checking_result === "no_issues" && q?.matched_document_id === transcriptDocId, JSON.stringify(q));
    check("INT: persisted excerpt + attribution", q?.matched_excerpt === "P03: I loved how simple the setup was." && q?.listed_participant_id === "P03", JSON.stringify(q));
    const { data: rev } = await anna.from("reviews").select("processing_status").eq("id", reviewId).maybeSingle();
    check("INT: review marked complete", rev?.processing_status === "complete", JSON.stringify(rev));

    // Mismatch scenario: report names P03, but the quote is in P05's speech.
    const reviewId2 = randomUUID();
    const rep2 = randomUUID();
    const t03 = randomUUID();
    const t05 = randomUUID();
    const base2 = `${annaId}/${reviewId2}`;
    await anna.from("reviews").insert({ id: reviewId2, user_id: annaId, name: "mismatch" });
    await anna.from("documents").insert([
      { id: rep2, review_id: reviewId2, user_id: annaId, role: "report", filename: "report.md", storage_path: `${base2}/report.md` },
      { id: t03, review_id: reviewId2, user_id: annaId, role: "transcript", filename: "p03.md", storage_path: `${base2}/p03.md`, participant_id: "P03" },
      { id: t05, review_id: reviewId2, user_id: annaId, role: "transcript", filename: "p05.md", storage_path: `${base2}/p05.md`, participant_id: "P05" },
    ]);
    await up(`${base2}/report.md`, `P03 said, "this was only said by p05."\n`);
    await up(`${base2}/p03.md`, `P03: nothing relevant here.\n`);
    await up(`${base2}/p05.md`, `P05: this was only said by p05.\n`);

    const res2 = await runReviewCheck(anna, annaId, reviewId2);
    check("INT2: mismatch run complete", res2.status === "complete", JSON.stringify(res2));
    const { data: qs2 } = await anna
      .from("quotations")
      .select("checking_result, matched_document_id, listed_participant_id")
      .eq("review_id", reviewId2);
    const q2 = qs2?.[0];
    check("INT2: has_issues + matched actual speaker P05", q2?.checking_result === "has_issues" && q2?.matched_document_id === t05, JSON.stringify(q2));
    check("INT2: report attribution recorded as P03", q2?.listed_participant_id === "P03", JSON.stringify(q2));
    const { data: iss2 } = await anna
      .from("issues")
      .select("issue_type, source_document_id, source_excerpt")
      .eq("review_id", reviewId2);
    const i2 = iss2?.[0];
    check(
      "INT2: participant_mismatch with source evidence",
      i2?.issue_type === "participant_mismatch" && i2?.source_document_id === t05 && i2?.source_excerpt === "P05: this was only said by p05.",
      JSON.stringify(i2),
    );

    // Credited participant has NO uploaded transcript (mm-report scenario):
    // report credits P03, only P05's file is present -> still a participant mismatch.
    const reviewId3 = randomUUID();
    const rep3 = randomUUID();
    const t05b = randomUUID();
    const base3 = `${annaId}/${reviewId3}`;
    await anna.from("reviews").insert({ id: reviewId3, user_id: annaId, name: "no-p03-file" });
    await anna.from("documents").insert([
      { id: rep3, review_id: reviewId3, user_id: annaId, role: "report", filename: "report.md", storage_path: `${base3}/report.md` },
      { id: t05b, review_id: reviewId3, user_id: annaId, role: "transcript", filename: "p05.md", storage_path: `${base3}/p05.md`, participant_id: "P05" },
    ]);
    await up(`${base3}/report.md`, `P03 said, "the dashboard saved me time."\n`);
    await up(`${base3}/p05.md`, `P05: the dashboard saved me time.\n`);

    const res3 = await runReviewCheck(anna, annaId, reviewId3);
    check("INT3: run complete", res3.status === "complete", JSON.stringify(res3));
    const { data: qs3 } = await anna
      .from("quotations")
      .select("checking_result, matched_document_id, listed_participant_id")
      .eq("review_id", reviewId3);
    const q3 = qs3?.[0];
    check(
      "INT3: transcript-less P03 credit -> has_issues + matched actual speaker P05",
      q3?.checking_result === "has_issues" && q3?.matched_document_id === t05b && q3?.listed_participant_id === "P03",
      JSON.stringify(q3),
    );
    const { data: iss3 } = await anna.from("issues").select("issue_type").eq("review_id", reviewId3);
    check("INT3: participant_mismatch issue", iss3?.[0]?.issue_type === "participant_mismatch", JSON.stringify(iss3));
  } finally {
    try { if (uploaded.length) await admin.storage.from(REVIEW_FILES_BUCKET).remove(uploaded); } catch (e) { console.error("cleanup storage:", (e as Error).message); }
    try { await admin.auth.admin.deleteUser(annaId); } catch (e) { console.error("cleanup user:", (e as Error).message); }
  }
}

integration()
  .then(() => {
    console.log(failures === 0 ? "================  ALL CHECKS PASSED  ================" : `================  ${failures} FAILED  ================`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error("ERROR:", e);
    process.exit(3);
  });
