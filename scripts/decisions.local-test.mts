// Local integration test for lib/reviews/decisions.ts against the disposable
// local Supabase stack. Creates a synthetic user, runs a check to produce a real
// issue, then saves and switches the decision AS that user (RLS applies), and
// asserts the stored rows. Cleans up after itself.
//
//   npx tsx scripts/decisions.local-test.mts
//
// Prereqs: Docker running, `npx supabase start` up, migrations applied.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { runReviewCheck, REVIEW_FILES_BUCKET } from "../lib/reviews/run-check";
import { setDecision, decisionSavedMessage } from "../lib/reviews/decisions";

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) console.log(`PASS: ${name}`);
  else {
    failures += 1;
    console.error(`FAIL: ${name} ${extra}`);
  }
}

// --- pure: the saved-confirmation text matches the saved choice ---
check("message: needs_correction", decisionSavedMessage("needs_correction") === "Review decision saved: Needs correction");
check("message: dismiss", decisionSavedMessage("dismiss") === "Review decision saved: Dismiss");
check("message: investigate", decisionSavedMessage("investigate") === "Review decision saved: Investigate");

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

async function main() {
  const { url, anon, service } = resolveLocalConfig();
  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const email = `dec+${Date.now()}@synthetic.test`;
  const password = "synthetic-password-123";
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error || !created.data.user) throw new Error(`createUser: ${created.error?.message}`);
  const userId = created.data.user.id;
  const anna = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const signin = await anna.auth.signInWithPassword({ email, password });
  if (signin.error) throw new Error(`signIn: ${signin.error.message}`);

  const reviewId = randomUUID();
  const rep = randomUUID();
  const t03 = randomUUID();
  const t05 = randomUUID();
  const base = `${userId}/${reviewId}`;
  const uploaded: string[] = [];
  const up = async (path: string, content: string) => {
    const { error } = await (anna as SupabaseClient).storage
      .from(REVIEW_FILES_BUCKET)
      .upload(path, new Blob([content], { type: "text/markdown" }), { upsert: false });
    if (error) throw new Error(`upload ${path}: ${error.message}`);
    uploaded.push(path);
  };

  try {
    await anna.from("reviews").insert({ id: reviewId, user_id: userId, name: "decisions" });
    await anna.from("documents").insert([
      { id: rep, review_id: reviewId, user_id: userId, role: "report", filename: "report.md", storage_path: `${base}/report.md` },
      { id: t03, review_id: reviewId, user_id: userId, role: "transcript", filename: "p03.md", storage_path: `${base}/p03.md`, participant_id: "P03" },
      { id: t05, review_id: reviewId, user_id: userId, role: "transcript", filename: "p05.md", storage_path: `${base}/p05.md`, participant_id: "P05" },
    ]);
    await up(`${base}/report.md`, `P03 said, "only p05 said this."\n`);
    await up(`${base}/p03.md`, `P03: nothing relevant.\n`);
    await up(`${base}/p05.md`, `P05: only p05 said this.\n`);

    const run = await runReviewCheck(anna, userId, reviewId);
    check("setup: check complete", run.status === "complete", JSON.stringify(run));

    const { data: issues } = await anna.from("issues").select("id, issue_type").eq("review_id", reviewId);
    const issueId = issues?.[0]?.id as string;
    check("setup: one issue to decide", (issues?.length ?? 0) === 1 && !!issueId, JSON.stringify(issues));

    // Save a decision.
    const saved = await setDecision(anna, userId, issueId, "needs_correction");
    check("save: returns saved", saved.status === "saved", JSON.stringify(saved));
    let { data: rows } = await anna.from("review_decisions").select("issue_id, decision, user_id").eq("issue_id", issueId);
    check("save: one row, needs_correction, owned", rows?.length === 1 && rows[0].decision === "needs_correction" && rows[0].user_id === userId, JSON.stringify(rows));

    // Switch it: still one row (UNIQUE issue_id upsert).
    const changed = await setDecision(anna, userId, issueId, "investigate");
    check("switch: returns saved", changed.status === "saved", JSON.stringify(changed));
    ({ data: rows } = await anna.from("review_decisions").select("issue_id, decision").eq("issue_id", issueId));
    check("switch: still one row, now investigate", rows?.length === 1 && rows[0].decision === "investigate", JSON.stringify(rows));

    // Switch back: still exactly one row (decisions are switched, never cleared).
    const back = await setDecision(anna, userId, issueId, "dismiss");
    check("switch back: returns saved", back.status === "saved", JSON.stringify(back));
    ({ data: rows } = await anna.from("review_decisions").select("issue_id, decision").eq("issue_id", issueId));
    check("switch back: still one row, now dismiss", rows?.length === 1 && rows[0].decision === "dismiss", JSON.stringify(rows));
  } finally {
    try {
      if (uploaded.length) await admin.storage.from(REVIEW_FILES_BUCKET).remove(uploaded);
    } catch (e) {
      console.error("cleanup storage:", (e as Error).message);
    }
    try {
      await admin.auth.admin.deleteUser(userId);
    } catch (e) {
      console.error("cleanup user:", (e as Error).message);
    }
  }
}

main()
  .then(() => {
    console.log(failures === 0 ? "================  ALL CHECKS PASSED  ================" : `================  ${failures} FAILED  ================`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error("ERROR:", e);
    process.exit(3);
  });
