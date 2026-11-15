// Local integration test for GENUINELY OVERLAPPING operations on the same review,
// and for independence between two reviews, against the disposable local Supabase
// stack (real Storage + RPCs). Overlap is made real by pausing a check mid-flight
// (its beforeAnalyze hook holds the `processing` lease) and attempting the
// conflicting operation while it runs, and by driving the actual upload/delete
// paths. Covers:
//   O1. check/delete (+ check/check): while a check is ACTIVE, delete is blocked and
//       a competing check is refused; files are untouched; the original completes.
//   O2. upload/check: while a review is UPLOADING, a check is refused; after finish
//       it checks normally.
//   O3. upload/delete: an ACTIVE upload blocks delete (files preserved); once stale
//       it is reclaimed and deleted.
//   O4. delete/check: while a review is DELETING, a check is refused.
//   O5. decision/delete: while a review is DELETING, a decision write is refused and
//       the stored decision is unchanged.
//   O6. independence: an active check on review A does not block checking review B
//       or deleting review C.
//
//   npx tsx scripts/overlap.local-test.mts
//
// Synthetic users + files only; cleans up after itself (local, never hosted).

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { runReviewCheck } from "../lib/reviews/run-check";
import { finishReviewSave, REVIEW_FILES_BUCKET } from "../lib/reviews/finish-save";
import { deleteReview, listReviewPrefixFiles } from "../lib/reviews/delete-review";
import { setDecision } from "../lib/reviews/decisions";

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
    const s = JSON.parse(
      execSync("npx supabase status -o json", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }),
    );
    url = url || s.API_URL;
    anon = anon || s.ANON_KEY;
    service = service || s.SERVICE_ROLE_KEY;
  }
  if (!url || !anon || !service) {
    console.error("Could not resolve local Supabase keys. Start the local stack (`npx supabase start`).");
    process.exit(2);
  }
  return { url, anon, service };
}

async function makeUser(admin: SupabaseClient, url: string, anon: string) {
  const email = `ovl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`;
  const password = "synthetic-password-123";
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error || !created.data.user) throw new Error(`createUser: ${created.error?.message}`);
  const client = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const signin = await client.auth.signInWithPassword({ email, password });
  if (signin.error) throw new Error(`signIn: ${signin.error.message}`);
  return { userId: created.data.user.id, client };
}

const DOCS = [
  { role: "report" as const, filename: "report.md", participantId: null },
  { role: "transcript" as const, filename: "p03.md", participantId: "P03" },
];

async function main() {
  const { url, anon, service } = resolveLocalConfig();
  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const { userId, client: anna } = await makeUser(admin, url, anon);
  const uploaded: string[] = [];

  const put = async (viaAdmin: boolean, path: string, content: string) => {
    const client = viaAdmin ? admin : anna;
    const { error } = await client.storage
      .from(REVIEW_FILES_BUCKET)
      .upload(path, new Blob([content], { type: "text/markdown" }), { upsert: true });
    if (error) throw new Error(`upload ${path}: ${error.message}`);
    uploaded.push(path);
  };

  // A draft review whose files sit under a token folder (admin fixtures bypass the
  // upload policy; runReviewCheck reads the documents' storage_path).
  async function fixtureDraft(name: string) {
    const reviewId = randomUUID();
    const token = randomUUID();
    const base = `${userId}/${reviewId}/${token}`;
    await admin.from("reviews").insert({ id: reviewId, user_id: userId, name, processing_status: "draft" });
    await admin.from("documents").insert([
      { id: randomUUID(), review_id: reviewId, user_id: userId, role: "report", filename: "report.md", storage_path: `${base}/report.md` },
      { id: randomUUID(), review_id: reviewId, user_id: userId, role: "transcript", filename: "p03.md", storage_path: `${base}/p03.md`, participant_id: "P03" },
    ]);
    await put(true, `${base}/report.md`, 'P03 said, "it was simple."\n');
    await put(true, `${base}/p03.md`, "P03: it was simple.\n");
    return reviewId;
  }

  // A REAL upload-in-progress: begin_upload (uploading) + user uploads under the
  // token folder; NOT finished (still `uploading`).
  async function realUpload(name: string) {
    const r = await anna.rpc("begin_upload", { p_name: name });
    const row = Array.isArray(r.data) ? r.data[0] : r.data;
    const reviewId = row.review_id as string;
    const opToken = row.op_token as string;
    const base = `${userId}/${reviewId}/${opToken}`;
    await put(false, `${base}/report.md`, 'P03 said, "it was simple."\n');
    await put(false, `${base}/p03.md`, "P03: it was simple.\n");
    return { reviewId, opToken };
  }

  async function fixtureComplete(name: string, withDecision = false) {
    const reviewId = randomUUID();
    const token = randomUUID();
    const rep = randomUUID();
    const base = `${userId}/${reviewId}/${token}`;
    await admin.from("reviews").insert({ id: reviewId, user_id: userId, name, processing_status: "complete" });
    await admin.from("documents").insert({ id: rep, review_id: reviewId, user_id: userId, role: "report", filename: "report.md", storage_path: `${base}/report.md` });
    await put(true, `${base}/report.md`, "report\n");
    let issueId: string | null = null;
    if (withDecision) {
      const q = randomUUID();
      issueId = randomUUID();
      await admin.from("quotations").insert({ id: q, review_id: reviewId, report_document_id: rep, user_id: userId, original_text: "q", start_offset: 0, end_offset: 1, checking_result: "has_issues" });
      await admin.from("issues").insert({ id: issueId, review_id: reviewId, quotation_id: q, user_id: userId, issue_type: "quote_not_found", explanation: "x" });
      await admin.from("review_decisions").insert({ issue_id: issueId, user_id: userId, decision: "dismiss" });
    }
    return { reviewId, issueId };
  }

  const fileCount = async (reviewId: string) => {
    const r = await listReviewPrefixFiles(anna, userId, reviewId);
    return r.ok ? r.paths.length : -1;
  };
  const statusOf = async (reviewId: string) =>
    (await anna.from("reviews").select("processing_status").eq("id", reviewId).maybeSingle()).data?.processing_status;

  try {
    // ---- O1: check ACTIVE -> delete blocked + competing check refused (genuine) ----
    {
      const reviewId = await fixtureDraft("O1");
      let delDuring: Awaited<ReturnType<typeof deleteReview>> | null = null;
      let checkDuring: Awaited<ReturnType<typeof runReviewCheck>> | null = null;
      const res = await runReviewCheck(anna, userId, reviewId, {
        // While THIS check holds the processing lease, attempt the conflicts.
        beforeAnalyze: async () => {
          delDuring = await deleteReview(anna, userId, reviewId);
          checkDuring = await runReviewCheck(anna, userId, reviewId);
        },
      });
      check("O1 active check blocks delete", delDuring!.status === "blocked", JSON.stringify(delDuring));
      check("O1 active check refuses a competing check", checkDuring!.status === "error" && /already running/.test((checkDuring as { message: string }).message), JSON.stringify(checkDuring));
      check("O1 the original check still completed", res.status === "complete", JSON.stringify(res));
      check("O1 files untouched (blocked delete removed nothing)", (await fileCount(reviewId)) > 0);
    }

    // ---- O2: upload/check -- uploading refuses a check; finish then checks ----
    {
      const { reviewId, opToken } = await realUpload("O2");
      const whileUploading = await runReviewCheck(anna, userId, reviewId);
      check("O2 uploading refuses a check", whileUploading.status === "error" && /still uploading/.test(whileUploading.message), JSON.stringify(whileUploading));
      const fin = await finishReviewSave(anna, userId, { reviewId, opToken, documents: DOCS });
      check("O2 finish -> saved", fin.status === "saved", JSON.stringify(fin));
      const after = await runReviewCheck(anna, userId, reviewId);
      check("O2 after finish the check runs", after.status === "complete", JSON.stringify(after));
    }

    // ---- O3: upload/delete -- active upload blocks delete; stale -> reclaimed ----
    {
      const { reviewId } = await realUpload("O3");
      const delActive = await deleteReview(anna, userId, reviewId);
      check("O3 active upload blocks delete", delActive.status === "blocked" && /upload is in progress/.test(delActive.status === "blocked" ? delActive.message : ""), JSON.stringify(delActive));
      check("O3 files preserved while blocked", (await fileCount(reviewId)) > 0);
      // Simulate the upload stalling (no heartbeat): now it is recoverable.
      await admin.from("reviews").update({ op_heartbeat_at: new Date(Date.now() - 3 * 60_000).toISOString() }).eq("id", reviewId);
      const delStale = await deleteReview(anna, userId, reviewId);
      check("O3 stale upload is reclaimed and deleted", delStale.status === "deleted", JSON.stringify(delStale));
      check("O3 files removed after reclaim-delete", (await fileCount(reviewId)) === 0);
    }

    // ---- O4: delete/check -- while deleting, a check is refused ----
    {
      const reviewId = await fixtureDraft("O4");
      const delTok = (await anna.rpc("begin_review_op", { p_review_id: reviewId, p_op: "deleting" })).data; // hold an active deleting lease
      check("O4 entered deleting", !!delTok);
      const checkWhileDeleting = await runReviewCheck(anna, userId, reviewId);
      check("O4 deleting refuses a check", checkWhileDeleting.status === "error" && /being deleted/.test(checkWhileDeleting.message), JSON.stringify(checkWhileDeleting));
    }

    // ---- O5: decision/delete -- while deleting, a decision write is refused ----
    {
      const { reviewId, issueId } = await fixtureComplete("O5", true);
      const before = (await anna.from("review_decisions").select("decision").eq("issue_id", issueId as string)).data?.[0]?.decision;
      await anna.rpc("begin_review_op", { p_review_id: reviewId, p_op: "deleting" }); // enter deleting (active)
      const decDuring = await setDecision(anna, userId, issueId as string, "investigate");
      check("O5 deleting refuses a decision write", decDuring.status === "error" && /being deleted/.test(decDuring.status === "error" ? decDuring.message : ""), JSON.stringify(decDuring));
      check("O5 stored decision unchanged", (await anna.from("review_decisions").select("decision").eq("issue_id", issueId as string)).data?.[0]?.decision === before);
    }

    // ---- O6: independence -- an active check on A does not block B or C ----
    {
      const a = await fixtureDraft("O6-A");
      await anna.rpc("begin_review_op", { p_review_id: a, p_op: "processing" }); // A actively processing
      const b = await fixtureDraft("O6-B");
      const checkB = await runReviewCheck(anna, userId, b);
      check("O6 review B checks independently while A is processing", checkB.status === "complete", JSON.stringify(checkB));
      const { reviewId: c } = await fixtureComplete("O6-C");
      const delC = await deleteReview(anna, userId, c);
      check("O6 review C deletes independently while A is processing", delC.status === "deleted", JSON.stringify(delC));
      check("O6 review A is unaffected (still processing)", (await statusOf(a)) === "processing");
    }
  } finally {
    try { if (uploaded.length) await admin.storage.from(REVIEW_FILES_BUCKET).remove(uploaded); } catch {}
    try {
      const { data: revs } = await admin.from("reviews").select("id, user_id").eq("user_id", userId);
      for (const r of revs ?? []) {
        await admin.from("review_file_cleanups").insert({ user_id: r.user_id, review_id: r.id, prefix: `${r.user_id}/${r.id}` });
        await admin.from("reviews").delete().eq("id", r.id);
      }
    } catch (e) { console.error("cleanup reviews:", (e as Error).message); }
    try { await admin.auth.admin.deleteUser(userId); } catch {}
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(3);
  }
  console.log("\nALL OVERLAP CHECKS PASSED");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
