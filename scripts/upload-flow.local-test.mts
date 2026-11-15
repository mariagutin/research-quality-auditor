// Local integration test for the UPLOAD flow through the REAL Storage API, against
// the disposable local Supabase stack. Covers the wired path:
//   begin_upload (review-row-first) -> upload files under the token folder ->
//   finishReviewSave -> finish_upload (uploading -> draft).
//
// Checks:
//   1. begin_upload returns a review id + lease token; the review is `uploading`.
//   2. A real PUT into the CURRENT attempt folder {uid}/{reviewId}/{token}/ works.
//   3. A real PUT into a WRONG token folder is REJECTED by the Storage policy.
//   4. finishReviewSave verifies the files and moves the review to `draft` with the
//      documents stored under the token path.
//   5. Resume idempotency: finishing again returns `saved` (no duplicate rows).
//   6. A finish with a superseded/bogus token is a `conflict`, not a save.
//
//   npx tsx scripts/upload-flow.local-test.mts
//
// Prereqs: Docker running, `npx supabase start` up, migrations applied.
// Synthetic users + files only; cleans up after itself (local, never hosted).

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { finishReviewSave, REVIEW_FILES_BUCKET } from "../lib/reviews/finish-save";

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
  const email = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`;
  const password = "synthetic-password-123";
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error || !created.data.user) throw new Error(`createUser: ${created.error?.message}`);
  const userId = created.data.user.id;
  const client = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const signin = await client.auth.signInWithPassword({ email, password });
  if (signin.error) throw new Error(`signIn: ${signin.error.message}`);
  return { userId, client };
}

async function putFile(client: SupabaseClient, path: string, content: string) {
  return client.storage
    .from(REVIEW_FILES_BUCKET)
    .upload(path, new Blob([content], { type: "text/markdown" }), { upsert: false });
}

async function main() {
  const { url, anon, service } = resolveLocalConfig();
  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const { userId, client } = await makeUser(admin, url, anon);

  let reviewId = "";
  let opToken = "";
  const uploaded: string[] = [];

  try {
    // 1. begin_upload: review-row-first.
    const begun = await client.rpc("begin_upload", { p_name: "Interview report" });
    const row = Array.isArray(begun.data) ? begun.data[0] : begun.data;
    reviewId = row?.review_id;
    opToken = row?.op_token;
    check("begin_upload returns review id + token", !begun.error && !!reviewId && !!opToken, JSON.stringify(begun.error ?? {}));

    const { data: r0 } = await client.from("reviews").select("processing_status, op_token").eq("id", reviewId).single();
    check("new review is `uploading` with the returned token", r0?.processing_status === "uploading" && r0?.op_token === opToken);

    // 2. Real PUTs into the CURRENT attempt folder.
    const base = `${userId}/${reviewId}/${opToken}`;
    const reportPath = `${base}/report.md`;
    const transcriptPath = `${base}/p03.md`;
    const up1 = await putFile(client, reportPath, 'P03 said, "the setup was simple."\n');
    const up2 = await putFile(client, transcriptPath, "P03: the setup was simple.\nP03: it saved me time.\n");
    if (!up1.error) uploaded.push(reportPath);
    if (!up2.error) uploaded.push(transcriptPath);
    check("real upload into the current attempt folder is allowed", !up1.error && !up2.error, `${up1.error?.message ?? ""} ${up2.error?.message ?? ""}`);

    // 3. A PUT into a WRONG token folder is rejected by the Storage policy.
    const wrongPath = `${userId}/${reviewId}/${randomUUID()}/late.md`;
    const bad = await putFile(client, wrongPath, "should be rejected\n");
    if (!bad.error) uploaded.push(wrongPath); // track so cleanup removes it if it leaked
    check("real upload under a WRONG token folder is rejected", !!bad.error, "policy allowed a non-current token");

    // 4. finishReviewSave -> finish_upload: uploading -> draft with token-path docs.
    const documents = [
      { role: "report" as const, filename: "report.md", participantId: null },
      { role: "transcript" as const, filename: "p03.md", participantId: "P03" },
    ];
    const fin = await finishReviewSave(client, userId, { reviewId, opToken, documents });
    check("finishReviewSave returns `saved`", fin.status === "saved", JSON.stringify(fin));

    const { data: r1 } = await client.from("reviews").select("processing_status, op_token").eq("id", reviewId).single();
    check("review moved to `draft` and the lease is cleared", r1?.processing_status === "draft" && r1?.op_token === null);

    const { data: docs } = await client.from("documents").select("role, storage_path, participant_id").eq("review_id", reviewId).order("role");
    const paths = (docs ?? []).map((d) => d.storage_path).sort();
    check("exactly 2 documents stored under the token path",
      (docs?.length === 2) && paths.every((p) => p.startsWith(`${base}/`)),
      JSON.stringify(paths));

    // 5. Resume idempotency: finishing again is still `saved` (no duplicate docs).
    const fin2 = await finishReviewSave(client, userId, { reviewId, opToken, documents });
    const { data: docs2 } = await client.from("documents").select("id").eq("review_id", reviewId);
    check("finishing again is idempotent (`saved`, still 2 docs)", fin2.status === "saved" && docs2?.length === 2, JSON.stringify(fin2));

    // 6. A finish with a bogus/superseded token is a conflict, not a save.
    const fin3 = await finishReviewSave(client, userId, { reviewId, opToken: randomUUID(), documents });
    check("finish with a superseded token is a `conflict`", fin3.status === "conflict", JSON.stringify(fin3));
  } finally {
    // Cleanup (local only): remove files, then delete the review (needs a cleanup
    // record for the delete guard), the cleanup record, and the synthetic user.
    try { if (uploaded.length) await client.storage.from(REVIEW_FILES_BUCKET).remove(uploaded); } catch {}
    if (reviewId) {
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
  console.log("\nALL UPLOAD-FLOW CHECKS PASSED");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
