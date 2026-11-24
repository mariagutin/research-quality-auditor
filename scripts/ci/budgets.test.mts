// CI unit test for SEC-02 upload/processing budgets.
//
// Covers the pure budget validators (lib/reviews/budgets.ts) and the two
// finish-save reject paths that the budget gate owns and that run before any
// Storage download or cleanup:
//   - too many transcripts (count gate, in validateShape), and
//   - an oversized file (size gate, in verifyFiles via the Storage listing).
// The full "valid upload is accepted" path is proven end-to-end against the local
// stack (docs/manual-browser-checklist.md / the SEC-02 verification run), since it
// needs real Storage objects; here we assert the gate accepts the valid sizes.

import {
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  MAX_TRANSCRIPTS,
  formatKb,
  fileSizeError,
  totalSizeError,
  transcriptCountError,
} from "../../lib/reviews/budgets";
import { finishReviewSave, type DocumentInput } from "../../lib/reviews/finish-save";

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) console.log(`PASS: ${name}`);
  else {
    failures += 1;
    console.error(`FAIL: ${name} ${extra}`);
  }
}

// ---------------------------------------------------------------------------
// Pure validators
// ---------------------------------------------------------------------------

check("formatKb: 115 KB", formatKb(MAX_FILE_BYTES) === "115 KB", formatKb(MAX_FILE_BYTES));
check("formatKb: 1495 KB", formatKb(MAX_TOTAL_BYTES) === "1495 KB", formatKb(MAX_TOTAL_BYTES));

check("count: 0 ok", transcriptCountError(0) === null);
check("count: 12 ok (at the cap)", transcriptCountError(MAX_TRANSCRIPTS) === null);
{
  const msg = transcriptCountError(13);
  check("count: 13 rejected", msg !== null);
  check("count: message names the cap", !!msg && msg.includes("at most 12"), msg ?? "");
  check("count: message names how many to remove", !!msg && msg.includes("Remove 1"), msg ?? "");
}
check("count: 20 rejected", transcriptCountError(20)?.includes("Remove 8") === true);

check("fileSize: empty list ok", fileSizeError([]) === null);
check(
  "fileSize: file exactly at the cap ok",
  fileSizeError([{ filename: "r.md", bytes: MAX_FILE_BYTES }]) === null,
);
{
  const over = fileSizeError([
    { filename: "small.md", bytes: 100 },
    { filename: "big.md", bytes: MAX_FILE_BYTES + 1 },
    { filename: "also-big.md", bytes: MAX_FILE_BYTES + 999 },
  ]);
  check("fileSize: one byte over is rejected", over !== null);
  check("fileSize: reports the FIRST offender", over?.filename === "big.md", over?.filename ?? "");
  check("fileSize: message names the limit", over?.message.includes("115 KB") === true, over?.message ?? "");
}

// 1 report + 12 transcripts, each exactly 115 KB => total exactly 1,495 KB.
{
  const thirteenAtCap = Array.from({ length: 13 }, (_, i) => ({ filename: `f${i}.md`, bytes: MAX_FILE_BYTES }));
  check("total: 13 files at the cap == budget, accepted", totalSizeError(thirteenAtCap) === null);
  const overByOne = [...thirteenAtCap, { filename: "x.md", bytes: 1 }];
  check("total: one byte over budget rejected", totalSizeError(overByOne) !== null);
  check("total: message names the budget", totalSizeError(overByOne)?.includes("1495 KB") === true);
}

// ---------------------------------------------------------------------------
// finish-save gate paths (stubbed; neither reaches Storage download or cleanup)
// ---------------------------------------------------------------------------

// A chainable stub: reviews -> .maybeSingle(); documents -> awaited directly.
function makeSupabase(opts: { review: unknown; docs: unknown[]; listing: unknown[] }) {
  const from = (table: string) => {
    const result = { data: table === "reviews" ? opts.review : opts.docs } as const;
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      maybeSingle: async () => result,
      then: (resolve: (v: unknown) => void) => resolve(result),
    };
    return builder;
  };
  const storage = {
    from: () => ({
      list: async () => ({ data: opts.listing, error: null }),
      download: async () => ({ data: null, error: { message: "not expected in this test" } }),
    }),
  };
  return { from, storage, rpc: async () => ({ error: null }) } as never;
}

// Count gate: 1 report + 13 transcripts -> invalid before any I/O.
{
  const docs: DocumentInput[] = [
    { role: "report", filename: "report.md" },
    ...Array.from({ length: 13 }, (_, i) => ({ role: "transcript" as const, filename: `p${i}.md`, participantId: `P${i}` })),
  ];
  const res = await finishReviewSave(makeSupabase({ review: null, docs: [], listing: [] }), "u1", {
    reviewId: "r1",
    opToken: "TOK",
    documents: docs,
  });
  check("finish: 13 transcripts -> invalid", res.status === "invalid", res.status);
  check("finish: 13 transcripts -> clear message", res.status === "invalid" && res.message.includes("at most 12"), JSON.stringify(res));
}

// Size gate: an oversized report caught from the Storage listing -> file_rejected.
{
  const docs: DocumentInput[] = [
    { role: "report", filename: "report.md", clientId: "rep" },
    { role: "transcript", filename: "p01.md", participantId: "P01", clientId: "t1" },
  ];
  const supabase = makeSupabase({
    review: { id: "r2", processing_status: "uploading", op_token: "TOK", op_failed_at: null },
    docs: [],
    listing: [
      { name: "report.md", metadata: { size: MAX_FILE_BYTES + 1 } },
      { name: "p01.md", metadata: { size: 2000 } },
    ],
  });
  const res = await finishReviewSave(supabase, "u1", { reviewId: "r2", opToken: "TOK", documents: docs });
  check("finish: oversize file -> file_rejected", res.status === "file_rejected", JSON.stringify(res));
  check("finish: oversize file -> names the file", res.status === "file_rejected" && res.filename === "report.md", JSON.stringify(res));
  check("finish: oversize file -> clear message", res.status === "file_rejected" && res.message.includes("115 KB"), JSON.stringify(res));
  check("finish: oversize file -> flags that exact client row", res.status === "file_rejected" && res.documentId === "rep", JSON.stringify(res));
}

// Size gate accepts the valid shape (1 report + 12 transcripts at the cap): the
// listing sizes pass both the per-file and total checks, so finish proceeds past
// the size gate (and then downloads, which this stub does not model).
{
  const sizes = Array.from({ length: 13 }, (_, i) => ({ name: i === 0 ? "report.md" : `p${i}.md`, metadata: { size: MAX_FILE_BYTES } }));
  check(
    "gate accepts 13 files at the cap (per-file + total)",
    fileSizeError(sizes.map((s) => ({ filename: s.name, bytes: s.metadata.size }))) === null &&
      totalSizeError(sizes.map((s) => ({ filename: s.name, bytes: s.metadata.size }))) === null,
  );
}

console.log(failures === 0 ? "\nAll budget tests passed." : `\n${failures} budget test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
