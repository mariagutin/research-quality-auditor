// Focused regression for two upload-recovery cases, against the disposable local
// Supabase stack (real Storage API):
//
//   Case 1 (cleanup-aware retry):
//     U.  cleanupPending() gate logic: pending when any folder is not emptied/ok.
//     C1a. A retry stamps a fresh token, records a reminder for the retired token,
//          and cleanup empties that folder (so cleanup is NOT pending -> uploads
//          may proceed).
//     C1b. A RESUME (cleanup only, no retry_upload) does NOT create another attempt:
//          the live token and the reminder set are unchanged.
//
//   Case 2 (uncertain-save recovery, the form's resume sequence):
//     C2.  If finish_upload SUCCEEDED but its response was lost, the form's
//          reconcile-first resume (finishReviewSave again, same id/token) returns
//          `saved`, opens the existing Draft, does NOT mark it failed, and does NOT
//          start another review (no re-upload).
//
//   npx tsx scripts/upload-recovery.local-test.mts
//
// Synthetic users + files only; cleans up after itself (local, never hosted).

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execSync } from "node:child_process";
import { finishReviewSave, REVIEW_FILES_BUCKET } from "../lib/reviews/finish-save";
import { cleanupDeadAttempts, cleanupPending } from "../lib/reviews/upload-cleanup";

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
  const email = `recover-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`;
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

// Pure gate-logic checks (no DB): the gate that decides "do not upload / do not
// finish while cleanup is pending".
function unitCleanupPending() {
  check("U cleanupPending([]) is false (nothing to clean)", cleanupPending([]) === false);
  check("U all-emptied is not pending",
    cleanupPending([{ token: "a", ok: true, emptied: true }]) === false);
  check("U a not-emptied folder is pending (do not upload)",
    cleanupPending([{ token: "a", ok: true, emptied: false }]) === true);
  check("U a failed (ok:false) folder is pending",
    cleanupPending([{ token: "a", ok: false, emptied: false, message: "x" }]) === true);
}

async function main() {
  unitCleanupPending();

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
  async function uploadBoth(reviewId: string, token: string) {
    await put(`${userId}/${reviewId}/${token}/report.md`, 'P03 said, "simple."\n');
    await put(`${userId}/${reviewId}/${token}/p03.md`, "P03: simple.\n");
  }
  const reminders = async (reviewId: string) =>
    (await client.from("review_dead_upload_attempts").select("token").eq("review_id", reviewId)).data?.map((r) => r.token) ?? [];
  const reviewRow = (reviewId: string) =>
    client.from("reviews").select("processing_status, op_token, op_failed_at").eq("id", reviewId).single();
  const userReviewCount = async () =>
    (await client.from("reviews").select("id").eq("user_id", userId)).data?.length ?? 0;

  try {
    // ---- C1a: cleanup-aware retry (success path -> not pending) ----
    // ---- C1b: resume does not create another attempt ----
    {
      const { reviewId, opToken: t1 } = await begin("Recover C1");
      await uploadBoth(reviewId, t1);
      await client.rpc("fail_review_op", { p_review_id: reviewId, p_token: t1 });
      const t2 = (await client.rpc("retry_upload", { p_review_id: reviewId })).data as string;

      const cleaned1 = await cleanupDeadAttempts(client, userId, reviewId);
      check("C1a retry+cleanup: reminder for T1, folder emptied, NOT pending",
        (await reminders(reviewId)).includes(t1) && !cleanupPending(cleaned1) &&
        cleaned1.length === 1 && cleaned1[0].token === t1 && cleaned1[0].emptied);

      // Resume = cleanup again WITHOUT retry_upload. Must not create another attempt.
      const tokenBefore = (await reviewRow(reviewId)).data?.op_token;
      const remBefore = (await reminders(reviewId)).sort();
      const cleaned2 = await cleanupDeadAttempts(client, userId, reviewId);
      const tokenAfter = (await reviewRow(reviewId)).data?.op_token;
      const remAfter = (await reminders(reviewId)).sort();
      check("C1b resume cleanup makes no new attempt (token + reminders unchanged)",
        tokenAfter === tokenBefore && tokenAfter === t2 &&
        JSON.stringify(remAfter) === JSON.stringify(remBefore) && !cleanupPending(cleaned2));
    }

    // ---- C2: uncertain-save recovery -- reconcile a lost-response success ----
    {
      const { reviewId, opToken: t1 } = await begin("Recover C2");
      await uploadBoth(reviewId, t1);

      // finish_upload SUCCEEDS here, but imagine its response was LOST to the client.
      const first = await finishReviewSave(client, userId, { reviewId, opToken: t1, documents: DOCS });
      check("C2 setup: first finish actually saved (response assumed lost)", first.status === "saved");

      const countBefore = await userReviewCount();

      // The form's RESUME reconciles FIRST (finish again, same id/token) before any
      // upload. It must open the existing Draft, not fail it, not start a new review.
      const resumed = await finishReviewSave(client, userId, { reviewId, opToken: t1, documents: DOCS });
      const row = (await reviewRow(reviewId)).data;
      const countAfter = await userReviewCount();
      const docCount = (await client.from("documents").select("id").eq("review_id", reviewId)).data?.length;

      check("C2 resume reconciles to `saved` (opens the existing Draft)", resumed.status === "saved");
      check("C2 review is still draft and NOT marked failed", row?.processing_status === "draft" && row?.op_failed_at === null);
      check("C2 no new review started; documents unchanged", countAfter === countBefore && docCount === 2);
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
  console.log("\nALL UPLOAD-RECOVERY CHECKS PASSED");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
