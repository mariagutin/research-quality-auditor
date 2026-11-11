// Pure tests for the word-level comparison helper. No database.
//   npx tsx scripts/text-compare.local-test.mts

import assert from "node:assert/strict";
import {
  wordNorms,
  similarity,
  contiguousContains,
  diffSegments,
} from "../lib/reviews/text-compare.ts";

let failures = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (cond) console.log(`PASS: ${name}`);
  else {
    failures++;
    console.error(`FAIL: ${name} ${extra}`);
  }
}

// --- normalization ---
ok("norm lowercases + strips outer punctuation", JSON.stringify(wordNorms("The  dashboard, saved me TIME.")) === JSON.stringify(["the", "dashboard", "saved", "me", "time"]));

// --- similarity ---
const s1 = similarity(wordNorms("the dashboard saved me time"), wordNorms("the dashboard saved me a lot of time"));
ok("insertion scores ~0.77", Math.abs(s1 - 0.769) < 0.01, String(s1));
const s2 = similarity(wordNorms("the tool was reliable"), wordNorms("the tool was not reliable"));
ok("negation scores ~0.89 (flagged, meaning aside)", Math.abs(s2 - 0.889) < 0.01, String(s2));
const s3 = similarity(wordNorms("it saved me time"), wordNorms("it saved me money"));
ok("one-word swap scores 0.75", Math.abs(s3 - 0.75) < 0.001, String(s3));
ok("identical scores 1.0", similarity(wordNorms("a b c"), wordNorms("a b c")) === 1);
ok("case/punct only scores 1.0", similarity(wordNorms("Saved me time."), wordNorms("saved me time")) === 1);
ok("unrelated scores low", similarity(wordNorms("the team shipped the feature on time"), wordNorms("the team missed the deadline on the project")) < 0.7);

// --- contiguous (exact up to case/punct) ---
ok("contiguous: verbatim present", contiguousContains(wordNorms("well it was simple honestly"), wordNorms("it was simple")));
ok("contiguous: case/punct insensitive", contiguousContains(wordNorms("it saved me time."), wordNorms("Saved ME time")) === false || contiguousContains(wordNorms("it saved me time."), wordNorms("saved me time")));
ok("contiguous: interrupted words are NOT contiguous", !contiguousContains(wordNorms("saved me a lot of time"), wordNorms("saved me time")));
ok("contiguous: negation breaks it", !contiguousContains(wordNorms("the tool was not reliable"), wordNorms("the tool was reliable")));
ok("contiguous: empty needle is false", !contiguousContains(wordNorms("anything here"), []));

// --- diff segments: which words are highlighted ---
{
  const { a, b } = diffSegments("the dashboard saved me time", "the dashboard saved me a lot of time");
  const aChanged = a.filter((s) => s.changed).map((s) => s.text);
  const bChanged = b.filter((s) => s.changed).map((s) => s.text);
  ok("diff: report side has no changed words (all present in transcript)", aChanged.length === 0, JSON.stringify(aChanged));
  ok("diff: transcript side highlights the inserted words", JSON.stringify(bChanged) === JSON.stringify(["a", "lot", "of"]), JSON.stringify(bChanged));
  // Rejoining preserves text verbatim.
  ok("diff: a rejoins verbatim", a.map((s) => s.text).join("") === "the dashboard saved me time");
  ok("diff: b rejoins verbatim", b.map((s) => s.text).join("") === "the dashboard saved me a lot of time");
}
{
  const { a, b } = diffSegments("it saved me time", "it saved me money");
  ok("diff: substitution highlights 'time' on report side", a.filter((s) => s.changed).map((s) => s.text).join(",") === "time");
  ok("diff: substitution highlights 'money' on transcript side", b.filter((s) => s.changed).map((s) => s.text).join(",") === "money");
}

console.log(failures === 0 ? "================  ALL CHECKS PASSED  ================" : `================  ${failures} FAILED  ================`);
process.exit(failures === 0 ? 0 : 1);
