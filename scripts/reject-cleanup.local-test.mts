// Local integration test for REJECTED-UPLOAD handling (finding #2), through the real
// Storage API + lifecycle RPCs against the disposable local stack.
//
// The handler (app/reviews/new/upload-form.tsx -> handleFileRejected) does, on a
// file_rejected finish:
//   1. fail_review_op(reviewId, token)   -- token-fenced; leaves the review
//      failed/recoverable instead of silently 'uploading'.
//   2. removeAttemptFolder(reviewId, token) -- sweeps ONLY this attempt's folder.
//   3. NO whole-review delete.
//
// Checks:
//   A. Normal rejection: the review survives (not deleted), is recoverable
//      (op_failed_at set), and this attempt's files are swept. The file_rejected
//      result carries the rejected file's STABLE id + role (finding #5).
//   B. CONCURRENT RECLAIM during rejection handling: after we fail attempt T1,
//      another tab reclaims (retry_upload -> T2) and uploads under T2. Our T1 cleanup
//      must sweep ONLY T1, leave T2's files intact, and never delete the review; and
//      a late fail_review_op(T1) must be a no-op (cannot clobber the live T2 attempt).
//
//   npx tsx scripts/reject-cleanup.local-test.mts
//
// Prereqs: Docker running, `npx supabase start` up, migrations applied.
// Synthetic users + files only; cleans up after itself. LOCAL ONLY, never hosted.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execSync } from "node:child_process";
import { finishReviewSave, REVIEW_FILES_BUCKET } from "../lib/reviews/finish-save";
import { removeAttemptFolder } from "../lib/reviews/upload-cleanup";

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
  if (!/127\.0\.0\.1|localhost/.test(url)) {
    console.error(`Refusing to run: SUPABASE_URL is not local (${url}).`);
    process.exit(2);
  }
  return { url, anon, service };
}

async function makeUser(admin: SupabaseClient, url: string, anon: string) {
  const email = `reject-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`;
  const password = "synthetic-password-123";
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error || !created.data.user) throw new Error(`createUser: ${created.error?.message}`);
  const client = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const signin = await client.auth.signInWithPassword({ email, password });
  if (signin.error) throw new Error(`signIn: ${signin.error.message}`);
  return { userId: created.data.user.id, client };
}

async function put(client: SupabaseClient, path: string, content: string) {
  return client.storage.from(REVIEW_FILES_BUCKET).upload(path, new Blob([content], { type: "text/markdown" }), {
    upsert: false,
  });
}
async function listFolder(client: SupabaseClient, prefix: string): Promise<string[]> {
  const { data } = await client.storage.from(REVIEW_FILES_BUCKET).list(prefix);
  return (data ?? []).map((o) => o.name);
}
async function reviewRow(client: SupabaseClient, id: string) {
  const { data } = await client.from("reviews").select("processing_status, op_token, op_failed_at").eq("id", id).maybeSingle();
  return data;
}

const REPORT = 'P05 said, "the export flow needs work."\n';
const BAD_TRANSCRIPT = "P05: the export flow needs work.\nP03: onboarding was rough too.\n"; // stray P03: -> rejected
const GOOD_TRANSCRIPT = "P05: the export flow needs work.\nP05: it was frustrating.\n";
const DOCS = [
  { role: "report" as const, filename: "report.md", participantId: null, clientId: "rep-1" },
  { role: "transcript" as const, filename: "p05.md", participantId: "P05", clientId: "tx-1" },
];

async function beginAttempt(client: SupabaseClient, name: string): Promise<{ reviewId: string; token: string }> {
  const begun = await client.rpc("begin_upload", { p_name: name });
  const row = Array.isArray(begun.data) ? begun.data[0] : begun.data;
  if (begun.error || !row?.review_id) throw new Error(`begin_upload: ${begun.error?.message}`);
  return { reviewId: row.review_id, token: row.op_token };
}

async function main() {
  const { url, anon, service } = resolveLocalConfig();
  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const { userId, client } = await makeUser(admin, url, anon);
  const reviewIds: string[] = [];

  try {
    // ========================================================================
    // A. Normal rejection: fail + attempt-folder sweep, review left recoverable.
    // ========================================================================
    {
      const { reviewId, token } = await beginAttempt(client, "Reject A");
      reviewIds.push(reviewId);
      const base = `${userId}/${reviewId}/${token}`;
      await put(client, `${base}/report.md`, REPORT);
      await put(client, `${base}/p05.md`, BAD_TRANSCRIPT);

      const fin = await finishReviewSave(client, userId, { reviewId, opToken: token, documents: DOCS });
      check("A: finish returns file_rejected", fin.status === "file_rejected", JSON.stringify(fin));
      if (fin.status === "file_rejected") {
        check("A: rejection identifies the exact transcript by stable id", fin.documentId === "tx-1", fin.documentId);
        check("A: rejection carries role=transcript", fin.role === "transcript", fin.role);
      }

      // --- handler: fail this attempt, then sweep only this attempt's folder ---
      await client.rpc("fail_review_op", { p_review_id: reviewId, p_token: token });
      const swept = await removeAttemptFolder(client, userId, reviewId, token);
      check("A: attempt folder swept (emptied)", swept.ok === true && swept.emptied === true, JSON.stringify(swept));

      const row = await reviewRow(client, reviewId);
      check("A: review NOT deleted (still exists)", !!row, JSON.stringify(row));
      check("A: review is recoverable (op_failed_at set, still uploading)",
        row?.processing_status === "uploading" && row?.op_failed_at != null, JSON.stringify(row));
      check("A: attempt files are gone", (await listFolder(client, base)).length === 0);
    }

    // ========================================================================
    // B. CONCURRENT RECLAIM during rejection handling.
    // ========================================================================
    {
      const { reviewId, token: t1 } = await beginAttempt(client, "Reject B");
      reviewIds.push(reviewId);
      const base1 = `${userId}/${reviewId}/${t1}`;
      await put(client, `${base1}/report.md`, REPORT);
      await put(client, `${base1}/p05.md`, BAD_TRANSCRIPT);
      const fin = await finishReviewSave(client, userId, { reviewId, opToken: t1, documents: DOCS });
      check("B: finish returns file_rejected", fin.status === "file_rejected", JSON.stringify(fin));

      // handler step 1: fail attempt T1 (makes the review recoverable).
      await client.rpc("fail_review_op", { p_review_id: reviewId, p_token: t1 });

      // --- ANOTHER TAB RECLAIMS: retry_upload -> T2, uploads good files, finishes. ---
      const retried = await client.rpc("retry_upload", { p_review_id: reviewId });
      const t2 = retried.data as string;
      check("B: another tab reclaimed with a new token", !retried.error && !!t2 && t2 !== t1, JSON.stringify(retried.error ?? t2));
      const base2 = `${userId}/${reviewId}/${t2}`;
      await put(client, `${base2}/report.md`, REPORT);
      await put(client, `${base2}/p05.md`, GOOD_TRANSCRIPT);
      const fin2 = await finishReviewSave(client, userId, { reviewId, opToken: t2, documents: DOCS });
      check("B: reclaimed attempt finishes (saved)", fin2.status === "saved", JSON.stringify(fin2));

      // handler step 2 (runs LATE, after the reclaim): sweep ONLY T1's folder.
      const swept = await removeAttemptFolder(client, userId, reviewId, t1);
      check("B: T1 folder swept", swept.ok === true, JSON.stringify(swept));

      // A late fail aimed at the OLD token must be a no-op (cannot clobber T2).
      const { data: lateFail } = await client.rpc("fail_review_op", { p_review_id: reviewId, p_token: t1 });
      check("B: late fail(T1) is a no-op (does not touch the live T2 attempt)", lateFail === false, JSON.stringify(lateFail));

      // Invariants: T2's files intact, T1 empty, review NOT deleted.
      check("B: reclaimed attempt's files are INTACT", (await listFolder(client, base2)).length === 2, base2);
      check("B: old attempt's files are gone", (await listFolder(client, base1)).length === 0, base1);
      const row = await reviewRow(client, reviewId);
      check("B: review NOT deleted by the rejection handler", !!row, JSON.stringify(row));
      check("B: review belongs to the reclaimed attempt (draft, lease cleared)",
        row?.processing_status === "draft" && row?.op_token === null, JSON.stringify(row));
    }
  } finally {
    // Cleanup (local only): delete reviews (+ their cleanup record so the delete
    // guard is satisfied), then the synthetic user. Leftover synthetic objects in the
    // local bucket are harmless; deleting the user cascades the DB rows.
    for (const reviewId of reviewIds) {
      const prefix = `${userId}/${reviewId}`;
      try {
        await admin.from("review_file_cleanups").insert({ user_id: userId, review_id: reviewId, prefix });
        await admin.from("reviews").delete().eq("id", reviewId);
        await admin.from("review_file_cleanups").delete().eq("user_id", userId).eq("prefix", prefix);
      } catch {}
    }
    try { await admin.auth.admin.deleteUser(userId); } catch {}
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(3);
  }
  console.log("\nALL REJECT-CLEANUP CHECKS PASSED");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
