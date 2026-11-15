// CI unit test for the review page's action gating (finding #4). The critical case:
// when review_op_active is UNAVAILABLE (RPC errored), the page must fail safe --
// disable Delete, hide Run check, and surface a retry -- never the permissive branch.
// Pure: actionGating only, no DB/network.

import { actionGating } from "../../lib/reviews/action-gating";

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) console.log(`PASS: ${name}`);
  else {
    failures += 1;
    console.error(`FAIL: ${name} ${extra}`);
  }
}

// 1. Status UNAVAILABLE -> fail safe, regardless of the (stale) status value.
for (const status of ["draft", "processing", "uploading", "complete", "failed", "deleting"]) {
  const g = actionGating({ status, opActive: false, opStatusUnavailable: true });
  check(`unavailable(${status}): statusUnavailable`, g.statusUnavailable === true, JSON.stringify(g));
  check(`unavailable(${status}): Run check hidden`, g.showRunCheck === false, JSON.stringify(g));
  check(`unavailable(${status}): Delete disabled`, g.deleteEnabled === false, JSON.stringify(g));
  check(`unavailable(${status}): no running message`, g.showRunningMessage === false, JSON.stringify(g));
}

// 2. draft, available, not active -> can run a check, can delete.
{
  const g = actionGating({ status: "draft", opActive: false, opStatusUnavailable: false });
  check("draft: Run check shown", g.showRunCheck === true, JSON.stringify(g));
  check("draft: Delete enabled", g.deleteEnabled === true, JSON.stringify(g));
  check("draft: not unavailable", g.statusUnavailable === false);
}

// 3. processing + ACTIVE -> running message, no Run check, Delete disabled.
{
  const g = actionGating({ status: "processing", opActive: true, opStatusUnavailable: false });
  check("processing-active: running message", g.showRunningMessage === true, JSON.stringify(g));
  check("processing-active: Run check hidden", g.showRunCheck === false, JSON.stringify(g));
  check("processing-active: Delete disabled", g.deleteEnabled === false, JSON.stringify(g));
}

// 4. processing + NOT active (recoverable/stale) -> re-run offered, Delete enabled.
{
  const g = actionGating({ status: "processing", opActive: false, opStatusUnavailable: false });
  check("processing-recoverable: Run check shown", g.showRunCheck === true, JSON.stringify(g));
  check("processing-recoverable: Delete enabled", g.deleteEnabled === true, JSON.stringify(g));
  check("processing-recoverable: no running message", g.showRunningMessage === false);
}

// 5. uploading -> Run check hidden (finish the upload first).
{
  const g = actionGating({ status: "uploading", opActive: false, opStatusUnavailable: false });
  check("uploading: Run check hidden", g.showRunCheck === false, JSON.stringify(g));
}

// 6. complete / deleting -> no Run check.
for (const status of ["complete", "deleting"]) {
  const g = actionGating({ status, opActive: false, opStatusUnavailable: false });
  check(`${status}: Run check hidden`, g.showRunCheck === false, JSON.stringify(g));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nALL ACTION-GATING CHECKS PASSED");
