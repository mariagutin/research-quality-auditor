// Local integration test for the DELETION flow, against the disposable local
// Supabase stack (real Storage + RPCs). Covers:
//   D1. Full delete: records cascade (documents/quotations/issues/decisions AND the
//       per-attempt upload reminders), the durable whole-prefix cleanup record is
//       created and RETAINED, and ALL files under the review's prefix are removed.
//   D2. Active-operation blocking: deletion is refused while a check is ACTIVE
//       (files preserved) and while a deletion is already active (no competing).
//   D3. Recovery after an interrupted deletion: (a) finalize committed but the sweep
//       didn't -> resumePendingDeletions finishes it; (b) a stale `deleting` is
//       reclaimed by a fresh deleteReview and finished.
//   D4. Cleanup is limited to the deleted review's EXACT prefix (a sibling review's
//       files are untouched).
//
//   npx tsx scripts/delete-review.local-test.mts
//
// Synthetic users + files only; cleans up after itself (local, never hosted).

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import {
  deleteReview,
  resumePendingDeletions,
  listReviewPrefixFiles,
  REVIEW_FILES_BUCKET,
} from "../lib/reviews/delete-review";

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
  const email = `del-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`;
  const password = "synthetic-password-123";
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error || !created.data.user) throw new Error(`createUser: ${created.error?.message}`);
  const client = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const signin = await client.auth.signInWithPassword({ email, password });
  if (signin.error) throw new Error(`signIn: ${signin.error.message}`);
  return { userId: created.data.user.id, client };
}

async function main() {
  const { url, anon, service } = resolveLocalConfig();
  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const { userId, client: anna } = await makeUser(admin, url, anon);
  const uploaded: string[] = [];

  async function put(path: string, content: string) {
    const { error } = await admin.storage
      .from(REVIEW_FILES_BUCKET)
      .upload(path, new Blob([content], { type: "text/markdown" }), { upsert: true });
    if (error) throw new Error(`upload ${path}: ${error.message}`);
    uploaded.push(path);
  }

  // A `complete` review with files under a current token folder, optionally a
  // retired-attempt reminder + file (handoff), and a quotation/issue/decision
  // (cascade). Returns ids and the number of files written.
  async function makeComplete(
    name: string,
    opts: { withReminder?: boolean; withDecision?: boolean } = {},
  ): Promise<{ reviewId: string; fileCount: number; issueId: string | null }> {
    const reviewId = randomUUID();
    const token = randomUUID();
    const rep = randomUUID();
    const tdoc = randomUUID();
    const base = `${userId}/${reviewId}`;
    await admin.from("reviews").insert({ id: reviewId, user_id: userId, name, processing_status: "complete" });
    await admin.from("documents").insert([
      { id: rep, review_id: reviewId, user_id: userId, role: "report", filename: "report.md", storage_path: `${base}/${token}/report.md` },
      { id: tdoc, review_id: reviewId, user_id: userId, role: "transcript", filename: "p03.md", storage_path: `${base}/${token}/p03.md`, participant_id: "P03" },
    ]);
    await put(`${base}/${token}/report.md`, 'P03 said, "it was simple."\n');
    await put(`${base}/${token}/p03.md`, "P03: it was simple.\n");
    let fileCount = 2;

    if (opts.withReminder) {
      const oldToken = randomUUID();
      await admin.from("review_dead_upload_attempts").insert({ review_id: reviewId, user_id: userId, token: oldToken });
      await put(`${base}/${oldToken}/stale.md`, "leftover from a retired attempt\n");
      fileCount += 1;
    }
    let issueId: string | null = null;
    if (opts.withDecision) {
      const q = randomUUID();
      issueId = randomUUID();
      await admin.from("quotations").insert({
        id: q, review_id: reviewId, report_document_id: rep, user_id: userId,
        original_text: "q", start_offset: 0, end_offset: 1, checking_result: "has_issues",
      });
      await admin.from("issues").insert({
        id: issueId, review_id: reviewId, quotation_id: q, user_id: userId, issue_type: "quote_not_found", explanation: "x",
      });
      await admin.from("review_decisions").insert({ issue_id: issueId, user_id: userId, decision: "dismiss" });
    }
    return { reviewId, fileCount, issueId };
  }

  const fileCount = async (reviewId: string) => {
    const r = await listReviewPrefixFiles(anna, userId, reviewId);
    return r.ok ? r.paths.length : -1;
  };
  const rowGone = async (reviewId: string) =>
    (await anna.from("reviews").select("id").eq("id", reviewId).maybeSingle()).data === null;
  const countIn = async (table: string, reviewId: string) =>
    (await admin.from(table).select("*").eq("review_id", reviewId)).data?.length ?? 0;
  const decisionsFor = async (issueId: string) =>
    (await admin.from("review_decisions").select("issue_id").eq("issue_id", issueId)).data?.length ?? 0;
  const hasCleanupRecord = async (reviewId: string) =>
    ((await admin.from("review_file_cleanups").select("review_id").eq("user_id", userId).eq("review_id", reviewId)).data?.length ?? 0) > 0;

  try {
    // ---- D1: full delete, handoff, cascade, real removal, retained record ----
    {
      const { reviewId, fileCount: n, issueId } = await makeComplete("D1", { withReminder: true, withDecision: true });
      check("D1 setup: files + reminder + decision present",
        (await fileCount(reviewId)) === n && (await decisionsFor(issueId as string)) === 1);
      const res = await deleteReview(anna, userId, reviewId);
      check("D1 deleteReview -> deleted, cleanup not pending (files all removed)",
        res.status === "deleted" && res.cleanupPending === false, JSON.stringify(res));
      check("D1 review row cascaded away", await rowGone(reviewId));
      check("D1 documents/quotations/issues cascaded",
        (await countIn("documents", reviewId)) === 0 &&
        (await countIn("quotations", reviewId)) === 0 &&
        (await countIn("issues", reviewId)) === 0);
      check("D1 decision cascaded (guard allowed the review's own cascade)", (await decisionsFor(issueId as string)) === 0);
      check("D1 per-attempt reminders cascaded", (await countIn("review_dead_upload_attempts", reviewId)) === 0);
      check("D1 durable whole-prefix cleanup record created + retained", await hasCleanupRecord(reviewId));
      check("D1 ALL files removed (current + retired attempt folders)", (await fileCount(reviewId)) === 0);
    }

    // ---- D2: active-operation blocking (files preserved; no competing deletion) ----
    {
      const { reviewId, fileCount: n } = await makeComplete("D2");
      await admin.from("reviews").update({
        processing_status: "processing", op_token: randomUUID(),
        op_heartbeat_at: new Date().toISOString(), op_failed_at: null,
      }).eq("id", reviewId);
      const r1 = await deleteReview(anna, userId, reviewId);
      check("D2 deletion blocked while a check is active", r1.status === "blocked", JSON.stringify(r1));
      check("D2 files preserved while blocked", (await fileCount(reviewId)) === n);

      await admin.from("reviews").update({
        processing_status: "deleting", op_token: randomUUID(),
        op_heartbeat_at: new Date().toISOString(), op_failed_at: null,
      }).eq("id", reviewId);
      const r2 = await deleteReview(anna, userId, reviewId);
      check("D2 no competing deletion (already in progress)", r2.status === "blocked" && /already in progress/.test(r2.message), JSON.stringify(r2));
    }

    // ---- D3a: finalize committed but sweep didn't -> owner-driven recovery ----
    {
      const { reviewId } = await makeComplete("D3a");
      await admin.from("review_file_cleanups").insert({ user_id: userId, review_id: reviewId, prefix: `${userId}/${reviewId}` });
      await admin.from("reviews").delete().eq("id", reviewId); // row gone, files orphaned
      check("D3a orphaned files present before recovery", (await fileCount(reviewId)) > 0);
      await resumePendingDeletions(anna, userId);
      check("D3a recovery removed the orphaned files", (await fileCount(reviewId)) === 0);
      check("D3a cleanup record retained after recovery", await hasCleanupRecord(reviewId));
    }

    // ---- D3b: a stale `deleting` is reclaimed by a fresh delete and finished ----
    {
      const { reviewId } = await makeComplete("D3b");
      await admin.from("reviews").update({
        processing_status: "deleting", op_token: randomUUID(),
        op_heartbeat_at: new Date(Date.now() - 3 * 60_000).toISOString(), op_failed_at: null, // stale
      }).eq("id", reviewId);
      const res = await deleteReview(anna, userId, reviewId);
      check("D3b stale interrupted deletion is recovered and finished", res.status === "deleted", JSON.stringify(res));
      check("D3b review gone + files removed", (await rowGone(reviewId)) && (await fileCount(reviewId)) === 0);
    }

    // ---- D4: cleanup limited to the deleted review's EXACT prefix ----
    {
      const a = await makeComplete("D4-A");
      const b = await makeComplete("D4-B");
      const res = await deleteReview(anna, userId, a.reviewId);
      check("D4 delete A -> deleted", res.status === "deleted", JSON.stringify(res));
      check("D4 A's files removed", (await fileCount(a.reviewId)) === 0);
      check("D4 sibling B's files UNTOUCHED (exact prefix only)", (await fileCount(b.reviewId)) === b.fileCount);
    }
  } finally {
    try { if (uploaded.length) await admin.storage.from(REVIEW_FILES_BUCKET).remove(uploaded); } catch {}
    try {
      const { data: revs } = await admin.from("reviews").select("id, user_id").eq("user_id", userId);
      for (const r of revs ?? []) {
        const prefix = `${r.user_id}/${r.id}`;
        await admin.from("review_file_cleanups").insert({ user_id: r.user_id, review_id: r.id, prefix });
        await admin.from("reviews").delete().eq("id", r.id);
      }
    } catch (e) { console.error("cleanup reviews:", (e as Error).message); }
    try { await admin.auth.admin.deleteUser(userId); } catch {} // cascades review_file_cleanups
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(3);
  }
  console.log("\nALL DELETE-FLOW CHECKS PASSED");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
