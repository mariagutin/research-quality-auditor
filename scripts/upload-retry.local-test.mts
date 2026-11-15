// Local integration test for the UPLOAD-RETRY path through the REAL Storage API,
// against the disposable local Supabase stack. Covers:
//   R1. Confirmed failure -> full retry (retry_upload) on the SAME review id with a
//       fresh token; a fixed-target reminder for the retired token is recorded and
//       RETAINED; its folder is cleaned; a fresh upload under the new token finishes.
//   R2. T2 cleanup paused while T3 starts: cleaning T1's folder (T2's fixed target)
//       must NOT touch T3's files, even though T3 became the live attempt meanwhile.
//   R3. Heartbeat: touch_review_op refreshes the lease's activity (current token).
//   R4. Reconciliation: a same-token resume after a successful save returns `saved`
//       (no restart, no duplicate documents).
//
//   npx tsx scripts/upload-retry.local-test.mts
//
// Prereqs: Docker running, `npx supabase start` up, migrations applied.
// Synthetic users + files only; cleans up after itself (local, never hosted).

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execSync } from "node:child_process";
import { finishReviewSave, REVIEW_FILES_BUCKET } from "../lib/reviews/finish-save";
import { removeAttemptFolder, cleanupDeadAttempts } from "../lib/reviews/upload-cleanup";

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
  const email = `retry-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`;
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
  const { userId, client } = await makeUser(admin, url, anon);
  const reviews: string[] = [];
  const uploaded: string[] = [];

  async function put(path: string, content: string) {
    const r = await client.storage
      .from(REVIEW_FILES_BUCKET)
      .upload(path, new Blob([content], { type: "text/markdown" }), { upsert: false });
    if (!r.error) uploaded.push(path);
    return r;
  }
  async function begin(name: string) {
    const r = await client.rpc("begin_upload", { p_name: name });
    const row = Array.isArray(r.data) ? r.data[0] : r.data;
    reviews.push(row.review_id);
    return { reviewId: row.review_id as string, opToken: row.op_token as string };
  }
  async function uploadBoth(userId: string, reviewId: string, token: string) {
    await put(`${userId}/${reviewId}/${token}/report.md`, 'P03 said, "it was simple."\n');
    await put(`${userId}/${reviewId}/${token}/p03.md`, "P03: it was simple.\n");
  }
  const reviewRow = (reviewId: string) =>
    client.from("reviews").select("processing_status, op_token, op_failed_at, op_heartbeat_at").eq("id", reviewId).single();
  const reminders = async (reviewId: string) =>
    (await client.from("review_dead_upload_attempts").select("token").eq("review_id", reviewId)).data?.map((r) => r.token) ?? [];
  const folderCount = async (prefix: string) =>
    ((await client.storage.from(REVIEW_FILES_BUCKET).list(prefix, { limit: 100 })).data ?? []).length;

  try {
    // ---- R1: confirmed failure -> full retry + fixed-target cleanup + finish ----
    {
      const { reviewId, opToken: t1 } = await begin("Retry R1");
      await uploadBoth(userId, reviewId, t1);

      const failed = await client.rpc("fail_review_op", { p_review_id: reviewId, p_token: t1 });
      check("R1 confirmed failure recorded", failed.data === true);

      const retry = await client.rpc("retry_upload", { p_review_id: reviewId });
      const t2 = retry.data as string;
      const row = (await reviewRow(reviewId)).data;
      check("R1 retry stamped a fresh token on the SAME review", !!t2 && t2 !== t1 && row?.op_token === t2 && row?.op_failed_at === null);
      check("R1 reminder recorded for the RETIRED token T1", (await reminders(reviewId)).includes(t1));

      const cleaned = await cleanupDeadAttempts(client, userId, reviewId);
      check("R1 fixed-target cleanup emptied T1's folder", cleaned.length === 1 && cleaned[0].token === t1 && cleaned[0].emptied);
      check("R1 T1 folder is now empty", (await folderCount(`${userId}/${reviewId}/${t1}`)) === 0);
      check("R1 reminder for T1 is RETAINED after cleanup", (await reminders(reviewId)).includes(t1));

      await uploadBoth(userId, reviewId, t2);
      const fin = await finishReviewSave(client, userId, { reviewId, opToken: t2, documents: DOCS });
      const row2 = (await reviewRow(reviewId)).data;
      check("R1 finish after retry -> saved + draft", fin.status === "saved" && row2?.processing_status === "draft");
    }

    // ---- R2: T2 cleanup paused while T3 starts; T3's files untouched ----
    {
      const { reviewId, opToken: t1 } = await begin("Retry R2");
      await put(`${userId}/${reviewId}/${t1}/report.md`, "t1 file\n");

      await client.rpc("fail_review_op", { p_review_id: reviewId, p_token: t1 });
      const t2 = (await client.rpc("retry_upload", { p_review_id: reviewId })).data as string;

      // T2's cleanup target is the reminder set {T1}, captured now but PAUSED.
      const t2CleanupTarget = (await reminders(reviewId)); // [t1]
      check("R2 T2 cleanup target is exactly {T1}", t2CleanupTarget.length === 1 && t2CleanupTarget[0] === t1);

      // ...meanwhile T3 starts and uploads before T2's cleanup resumes.
      await client.rpc("fail_review_op", { p_review_id: reviewId, p_token: t2 });
      const t3 = (await client.rpc("retry_upload", { p_review_id: reviewId })).data as string;
      await put(`${userId}/${reviewId}/${t3}/report.md`, "t3 file\n");
      check("R2 T3 is the live token", (await reviewRow(reviewId)).data?.op_token === t3);

      // Resume T2's cleanup: its fixed target is T1 only.
      const res = await removeAttemptFolder(client, userId, reviewId, t2CleanupTarget[0]);
      check("R2 T1 cleanup succeeded", res.ok === true && (res as { emptied: boolean }).emptied);
      check("R2 T1 folder empty", (await folderCount(`${userId}/${reviewId}/${t1}`)) === 0);
      check("R2 T3 files UNTOUCHED by T2's cleanup", (await folderCount(`${userId}/${reviewId}/${t3}`)) === 1);
      const rem = await reminders(reviewId);
      check("R2 reminders are {T1,T2}; T3 is never a dead token", rem.includes(t1) && rem.includes(t2) && !rem.includes(t3));
    }

    // ---- R3: heartbeat refreshes the lease's activity (current token) ----
    {
      const { reviewId, opToken: t1 } = await begin("Retry R3");
      // Simulate time passing with no activity (set heartbeat into the past).
      await admin.from("reviews").update({ op_heartbeat_at: new Date(Date.now() - 90_000).toISOString() }).eq("id", reviewId);
      const before = (await reviewRow(reviewId)).data?.op_heartbeat_at as string;
      const touched = await client.rpc("touch_review_op", { p_review_id: reviewId, p_token: t1 });
      const after = (await reviewRow(reviewId)).data?.op_heartbeat_at as string;
      check("R3 heartbeat refreshed by the current token", touched.data === true && new Date(after) > new Date(before));
    }

    // ---- R4: reconciliation -- same-token resume after success is `saved` ----
    {
      const { reviewId, opToken: t1 } = await begin("Retry R4");
      await uploadBoth(userId, reviewId, t1);
      const fin1 = await finishReviewSave(client, userId, { reviewId, opToken: t1, documents: DOCS });
      const fin2 = await finishReviewSave(client, userId, { reviewId, opToken: t1, documents: DOCS });
      const docCount = (await client.from("documents").select("id").eq("review_id", reviewId)).data?.length;
      check("R4 resume after success reconciles to `saved` (no restart, 2 docs)",
        fin1.status === "saved" && fin2.status === "saved" && docCount === 2);
    }
  } finally {
    try { if (uploaded.length) await client.storage.from(REVIEW_FILES_BUCKET).remove(uploaded); } catch {}
    for (const reviewId of reviews) {
      const prefix = `${userId}/${reviewId}`;
      await admin.from("review_file_cleanups").insert({ user_id: userId, review_id: reviewId, prefix });
      await admin.from("reviews").delete().eq("id", reviewId);
      await admin.from("review_file_cleanups").delete().eq("user_id", userId).eq("prefix", prefix);
    }
    try { await admin.auth.admin.deleteUser(userId); } catch {}
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(3);
  }
  console.log("\nALL UPLOAD-RETRY CHECKS PASSED");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
