// Owner-only listing test against the local Supabase stack. Two synthetic users
// each save a review; each must see ONLY their own via the same query the
// listing page uses (RLS boundary, NFR-01). Cleans up after itself.
//
//   npx tsx scripts/reviews-list.local-test.mts
//
// Prereqs: Docker running, `npx supabase start` up, migrations applied.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";

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

// The exact query the listing page runs, as a given signed-in client.
async function listReviews(client: SupabaseClient) {
  const { data } = await client
    .from("reviews")
    .select("id, name, processing_status, created_at")
    .order("created_at", { ascending: false });
  return data ?? [];
}

async function main() {
  const { url, anon, service } = resolveLocalConfig();
  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });

  const made: { userId: string; reviewId: string }[] = [];
  async function makeUserWithReview(label: string) {
    const email = `list-${label}-${Date.now()}@synthetic.test`;
    const password = "synthetic-password-123";
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) throw new Error(`createUser: ${created.error?.message}`);
    const userId = created.data.user.id;
    const client = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
    const signin = await client.auth.signInWithPassword({ email, password });
    if (signin.error) throw new Error(`signIn: ${signin.error.message}`);
    const reviewId = randomUUID();
    const { error } = await client.from("reviews").insert({ id: reviewId, user_id: userId, name: `${label}-review` });
    if (error) throw new Error(`insert review: ${error.message}`);
    made.push({ userId, reviewId });
    return { userId, reviewId, client };
  }

  try {
    const a = await makeUserWithReview("alice");
    const b = await makeUserWithReview("bob");

    const aList = await listReviews(a.client);
    const bList = await listReviews(b.client);

    check("A sees exactly their own review", aList.length === 1 && aList[0].id === a.reviewId, JSON.stringify(aList));
    check("A does NOT see B's review", !aList.some((r) => r.id === b.reviewId), JSON.stringify(aList));
    check("B sees exactly their own review", bList.length === 1 && bList[0].id === b.reviewId, JSON.stringify(bList));
    check("B does NOT see A's review", !bList.some((r) => r.id === a.reviewId), JSON.stringify(bList));
  } finally {
    for (const { reviewId } of made) {
      try {
        await admin.from("reviews").delete().eq("id", reviewId);
      } catch (e) {
        console.error("cleanup review:", (e as Error).message);
      }
    }
    for (const { userId } of made) {
      try {
        await admin.auth.admin.deleteUser(userId);
      } catch (e) {
        console.error("cleanup user:", (e as Error).message);
      }
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
