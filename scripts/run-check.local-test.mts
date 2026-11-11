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
