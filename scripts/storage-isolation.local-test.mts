// Local END-TO-END two-user Storage isolation test, through the REAL Supabase
// Storage HTTP API, against the disposable local stack.
//
// WHY THIS EXISTS: the SQL policy test (supabase/tests/review_files_storage_test.sql)
// exercises the RLS predicates on storage.objects directly, but cannot drive the
// actual Storage API delete path -- a STATEMENT-level `protect_delete` trigger blocks
// every DIRECT SQL delete (it only allows deletes when the Storage API sets the
// `storage.allow_delete_query` GUC after its own owner check). This test closes that
// gap by using the real HTTP API as two separate signed-in users.
//
// THE GUARANTEE UNDER TEST: user B must not be able to DOWNLOAD or DELETE user A's
// files. Deletion is judged by WHETHER A'S FILE SURVIVES UNCHANGED -- not by B's
// response status, because an unauthorized Storage delete can return success while
// removing nothing.
//
// CHECKS (A = owner, B = attacker; both real authenticated users):
//   1. Positive control: A uploads a synthetic file into A's own folder and can
//      download it back, byte-for-byte.
//   2. B cannot LIST A's folder (owner-only SELECT hides it entirely).
//   3. B cannot DOWNLOAD A's file (no bytes returned).
//   4. B's DELETE attempt removes NOTHING: regardless of the API response, A can
//      still download the file and its bytes are IDENTICAL to the original.
//
//   npx tsx scripts/storage-isolation.local-test.mts
//
// Prereqs: Docker running, `npx supabase start` up, migrations applied.
// Synthetic users + files only; cleans up after itself. LOCAL ONLY, never hosted.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execSync } from "node:child_process";
import { REVIEW_FILES_BUCKET } from "../lib/reviews/finish-save";

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
  // Guard: this test must only ever run against a LOCAL stack.
  if (!/127\.0\.0\.1|localhost/.test(url)) {
    console.error(`Refusing to run: SUPABASE_URL is not local (${url}). This test is local-only.`);
    process.exit(2);
  }
  return { url, anon, service };
}

async function makeUser(admin: SupabaseClient, url: string, anon: string, tag: string) {
  const email = `storiso-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`;
  const password = "synthetic-password-123";
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error || !created.data.user) throw new Error(`createUser(${tag}): ${created.error?.message}`);
  const userId = created.data.user.id;
  const client = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const signin = await client.auth.signInWithPassword({ email, password });
  if (signin.error) throw new Error(`signIn(${tag}): ${signin.error.message}`);
  return { userId, client };
}

async function main() {
  const { url, anon, service } = resolveLocalConfig();
  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });

  const a = await makeUser(admin, url, anon, "a");
  const b = await makeUser(admin, url, anon, "b");

  // Synthetic report content A will store. The exact bytes are the survival oracle.
  const ORIGINAL = 'P03 said, "the dashboard saved me time."\n';

  let reviewId = "";
  let opToken = "";
  let reportPath = "";

  try {
    // --- A places a real file in A's own folder via the real upload policy -------
    const begun = await a.client.rpc("begin_upload", { p_name: "Isolation report" });
    const row = Array.isArray(begun.data) ? begun.data[0] : begun.data;
    reviewId = row?.review_id;
    opToken = row?.op_token;
    if (begun.error || !reviewId || !opToken) throw new Error(`begin_upload: ${begun.error?.message}`);

    reportPath = `${a.userId}/${reviewId}/${opToken}/report.md`;
    const up = await a.client.storage
      .from(REVIEW_FILES_BUCKET)
      .upload(reportPath, new Blob([ORIGINAL], { type: "text/markdown" }), { upsert: false });
    if (up.error) throw new Error(`A upload: ${up.error.message}`);

    // 1. Positive control: A can download A's own file, byte-for-byte.
    const aGet = await a.client.storage.from(REVIEW_FILES_BUCKET).download(reportPath);
    const aText = aGet.data ? await aGet.data.text() : null;
    check("1. A can download A's own file (bytes match)", !aGet.error && aText === ORIGINAL,
      `err=${aGet.error?.message ?? ""} text=${JSON.stringify(aText)}`);

    // 2. B cannot LIST A's folder (owner-only SELECT => empty listing).
    const bList = await b.client.storage
      .from(REVIEW_FILES_BUCKET)
      .list(`${a.userId}/${reviewId}/${opToken}`);
    check("2. B cannot list A's folder (0 entries)", !bList.error && (bList.data?.length ?? 0) === 0,
      `err=${bList.error?.message ?? ""} n=${bList.data?.length ?? "?"}`);

    // 3. B cannot DOWNLOAD A's file (no bytes returned).
    const bGet = await b.client.storage.from(REVIEW_FILES_BUCKET).download(reportPath);
    const bText = bGet.data ? await bGet.data.text() : null;
    check("3. B cannot download A's file (no matching bytes)", !!bGet.error || bText !== ORIGINAL,
      `err=${bGet.error?.message ?? ""} gotOriginal=${bText === ORIGINAL}`);

    // 4. B attempts DELETE. We do NOT trust the API response -- we judge by survival.
    const bDel = await b.client.storage.from(REVIEW_FILES_BUCKET).remove([reportPath]);
    const bRemovedCount = bDel.data?.length ?? 0;
    console.log(
      `   (B's delete API response: error=${bDel.error?.message ?? "none"}, ` +
      `objects reported removed=${bRemovedCount})`,
    );

    // 4a. SURVIVAL ORACLE #1 (owner path): A can still download the UNCHANGED file.
    const aGet2 = await a.client.storage.from(REVIEW_FILES_BUCKET).download(reportPath);
    const aText2 = aGet2.data ? await aGet2.data.text() : null;
    check("4a. After B's delete, A still downloads the file with IDENTICAL bytes",
      !aGet2.error && aText2 === ORIGINAL,
      `err=${aGet2.error?.message ?? ""} text=${JSON.stringify(aText2)}`);

    // 4b. SURVIVAL ORACLE #2 (ground truth, RLS bypassed): an admin listing of A's
    //     folder -- the service role bypasses Storage RLS -- still shows the object.
    const adminList = await admin.storage
      .from(REVIEW_FILES_BUCKET)
      .list(`${a.userId}/${reviewId}/${opToken}`);
    const survives = (adminList.data ?? []).some((o) => o.name === "report.md");
    check("4b. The stored object still exists (admin/bypass confirms survival)",
      !adminList.error && survives,
      `err=${adminList.error?.message ?? ""} names=${JSON.stringify((adminList.data ?? []).map((o) => o.name))}`);

    // 4c. B genuinely removed nothing.
    check("4c. B's delete removed 0 objects", bRemovedCount === 0, `removed=${bRemovedCount}`);
  } finally {
    // Cleanup (local only): remove A's file as A, then delete review + cleanup
    // record + both synthetic users via admin (RLS bypass).
    try { if (reportPath) await a.client.storage.from(REVIEW_FILES_BUCKET).remove([reportPath]); } catch {}
    if (reviewId) {
      const prefix = `${a.userId}/${reviewId}`;
      try {
        await admin.from("review_file_cleanups").insert({ user_id: a.userId, review_id: reviewId, prefix });
        await admin.from("reviews").delete().eq("id", reviewId);
        await admin.from("review_file_cleanups").delete().eq("user_id", a.userId).eq("prefix", prefix);
      } catch {}
    }
    try { await admin.auth.admin.deleteUser(a.userId); } catch {}
    try { await admin.auth.admin.deleteUser(b.userId); } catch {}
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(3);
  }
  console.log("\nALL STORAGE-ISOLATION CHECKS PASSED");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
