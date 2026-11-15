// Focused regression for runReviewCheck's heartbeat + failure handling, against
// the disposable local Supabase stack (real Storage + RPCs):
//
//   LAZY. Empirically confirm our Supabase client's rpc() is lazy: a non-awaited
//         `void rpc()` does NOT execute; an awaited rpc() does. (This is why the
//         heartbeat must await, not `void supabase.rpc(...)`.)
//   HB.   The heartbeat TIMER advances op_heartbeat_at during a delayed check.
//   EX.   An unexpected exception (from analysis) is routed through the token-
//         fenced failure path (review -> `failed`) and returns a confirmed error.
//   US1.  An UNCERTAIN result-save after a takeover returns `uncertain` (not a
//         confirmed failure) and does not clobber the taking-over attempt.
//   US2.  An uncertain save whose review is actually complete reconciles to
//         `complete` (a lost response).
//   CF.   A confirmed analysis failure (no files) returns `error` and `failed` --
//         distinct from the uncertain outcomes above.
//
//   npx tsx scripts/check-heartbeat.local-test.mts
//
// Synthetic users + files only; cleans up after itself (local, never hosted).

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { runReviewCheck, REVIEW_FILES_BUCKET } from "../lib/reviews/run-check";

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) console.log(`PASS: ${name}`);
  else {
    failures += 1;
    console.error(`FAIL: ${name} ${extra}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  const email = `hb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`;
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

  // A draft review with real report + transcript files (fixtures uploaded via the
  // service-role client to bypass the upload-attempt policy, which is tested
  // elsewhere). runReviewCheck reads the documents' storage_path.
  async function makeDraft(name: string) {
    const reviewId = randomUUID();
    const base = `${userId}/${reviewId}`;
    await anna.from("reviews").insert({ id: reviewId, user_id: userId, name });
    await anna.from("documents").insert([
      { review_id: reviewId, user_id: userId, role: "report", filename: "report.md", storage_path: `${base}/report.md` },
      { review_id: reviewId, user_id: userId, role: "transcript", filename: "p03.md", storage_path: `${base}/p03.md`, participant_id: "P03" },
    ]);
    for (const [p, c] of [
      [`${base}/report.md`, 'P03 said, "it was simple."\n'],
      [`${base}/p03.md`, "P03: it was simple.\n"],
    ] as const) {
      await admin.storage.from(REVIEW_FILES_BUCKET).upload(p, new Blob([c], { type: "text/markdown" }), { upsert: true });
      uploaded.push(p);
    }
    return reviewId;
  }
  const heartbeatAt = async (rid: string) =>
    (await anna.from("reviews").select("op_heartbeat_at").eq("id", rid).single()).data?.op_heartbeat_at as string;
  const statusOf = async (rid: string) =>
    (await anna.from("reviews").select("processing_status, op_token").eq("id", rid).single()).data;

  try {
    // ---- LAZY: confirm rpc() laziness empirically ----
    {
      const rid = await makeDraft("lazy");
      const tok = (await anna.rpc("begin_review_op", { p_review_id: rid, p_op: "processing" })).data as string;
      const before = await heartbeatAt(rid);
      // Non-awaited builder: should NOT send the request.
      void anna.rpc("touch_review_op", { p_review_id: rid, p_token: tok });
      await sleep(300);
      const afterLazy = await heartbeatAt(rid);
      check("LAZY: a non-awaited rpc() does NOT execute (heartbeat unchanged)", afterLazy === before, `${before} -> ${afterLazy}`);
      // Awaited builder: DOES send the request.
      await anna.rpc("touch_review_op", { p_review_id: rid, p_token: tok });
      const afterAwait = await heartbeatAt(rid);
      check("LAZY: an awaited rpc() DOES execute (heartbeat advanced)", new Date(afterAwait) > new Date(before));
    }

    // ---- HB: the heartbeat TIMER advances op_heartbeat_at during a delayed check ----
    {
      const rid = await makeDraft("heartbeat");
      let advanced = false;
      const res = await runReviewCheck(anna, userId, rid, {
        heartbeatMs: 150,
        beforeAnalyze: async () => {
          const t0 = await heartbeatAt(rid); // after per-file touches; only the timer runs during the sleep
          await sleep(600);
          const t1 = await heartbeatAt(rid);
          advanced = new Date(t1) > new Date(t0);
        },
      });
      check("HB: check completed", res.status === "complete", JSON.stringify(res));
      check("HB: timer advanced op_heartbeat_at during the delay", advanced);
    }

    // ---- EX: an unexpected exception -> confirmed error + `failed` (timer cleared) ----
    {
      const rid = await makeDraft("exception");
      const res = await runReviewCheck(anna, userId, rid, {
        beforeAnalyze: async () => {
          throw new Error("boom from analysis");
        },
      });
      check("EX: unexpected exception -> confirmed `error`", res.status === "error", JSON.stringify(res));
      check("EX: lease released to `failed` via the fenced path", (await statusOf(rid))?.processing_status === "failed");
    }

    // ---- US1: uncertain save after a takeover -> `uncertain`, no clobber ----
    {
      const rid = await makeDraft("uncertain-takeover");
      const newToken = randomUUID();
      const res = await runReviewCheck(anna, userId, rid, {
        beforeSave: async () => {
          // A concurrent takeover re-stamps the lease before our save lands.
          await admin.from("reviews").update({ op_token: newToken, op_heartbeat_at: new Date().toISOString() }).eq("id", rid);
        },
      });
      check("US1: save after takeover -> `uncertain` (not error)", res.status === "uncertain", JSON.stringify(res));
      const row = await statusOf(rid);
      check("US1: did not clobber the taking-over attempt (still processing, new token)",
        row?.processing_status === "processing" && row?.op_token === newToken, JSON.stringify(row));
    }

    // ---- US2: uncertain save but review is actually complete -> reconcile ----
    {
      const rid = await makeDraft("uncertain-complete");
      const res = await runReviewCheck(anna, userId, rid, {
        beforeSave: async () => {
          // Simulate the save having committed (status complete) with the response lost.
          await admin.from("reviews").update({ processing_status: "complete", op_token: null }).eq("id", rid);
        },
      });
      check("US2: lost-response but review complete -> reconciled to `complete`", res.status === "complete", JSON.stringify(res));
    }

    // ---- CF: a confirmed analysis failure (no files) -> `error` + `failed` ----
    {
      const rid = randomUUID();
      await anna.from("reviews").insert({ id: rid, user_id: userId, name: "no-docs" });
      const res = await runReviewCheck(anna, userId, rid);
      check("CF: no files -> confirmed `error` (distinct from uncertain)", res.status === "error", JSON.stringify(res));
      check("CF: review released to `failed`", (await statusOf(rid))?.processing_status === "failed");
    }
  } finally {
    try { if (uploaded.length) await admin.storage.from(REVIEW_FILES_BUCKET).remove(uploaded); } catch {}
    try {
      const { data: revs } = await admin.from("reviews").select("id, user_id").eq("user_id", userId);
      for (const r of revs ?? []) {
        const prefix = `${r.user_id}/${r.id}`;
        await admin.from("review_file_cleanups").insert({ user_id: r.user_id, review_id: r.id, prefix });
        await admin.from("reviews").delete().eq("id", r.id);
        await admin.from("review_file_cleanups").delete().eq("user_id", r.user_id).eq("prefix", prefix);
      }
    } catch (e) { console.error("cleanup reviews:", (e as Error).message); }
    try { await admin.auth.admin.deleteUser(userId); } catch {}
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(3);
  }
  console.log("\nALL CHECK-HEARTBEAT CHECKS PASSED");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
