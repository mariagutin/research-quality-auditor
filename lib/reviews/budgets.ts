// Upload & processing budgets for a review (SEC-02).
//
// These are the documented, enforced limits on what one review may contain.
// They are verified at the TWO trusted boundaries that precede expensive work:
//   - the save boundary (lib/reviews/finish-save.ts), and
//   - the check boundary (lib/reviews/run-check.ts),
// and a matching file-size ceiling is set on the private Storage bucket itself
// (supabase migration 20261124000000) so an oversized PUT is refused before it
// ever reaches these checks. The browser form (app/reviews/new/upload-form.tsx)
// pre-checks the same limits for a friendly message, but the server is the gate.
//
// Units: "KB" here means KiB (1024 bytes), the unit a file manager shows. The
// numbers come from the Week 6 SEC-02 requirement and ADR-0011:
//   - one report + up to 12 transcripts (13 files),
//   - each .md file up to 115 KB,
//   - 1,495 KB (= 13 x 115 KB) total per review.

export const MAX_TRANSCRIPTS = 12;
export const MAX_FILES = 1 + MAX_TRANSCRIPTS; // 1 report + 12 transcripts = 13
export const MAX_FILE_BYTES = 115 * 1024; // 117,760
export const MAX_TOTAL_BYTES = 1495 * 1024; // 1,530,880  (= MAX_FILES x MAX_FILE_BYTES)

/** Whole-KB label for messages, e.g. 117760 -> "115 KB". */
export function formatKb(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`;
}

export interface SizedFile {
  filename: string;
  bytes: number;
}

/**
 * Too many transcripts? Returns a clear message, or null when within budget.
 * (Counts transcripts only; the single report is separate.)
 */
export function transcriptCountError(transcriptCount: number): string | null {
  if (transcriptCount <= MAX_TRANSCRIPTS) return null;
  const over = transcriptCount - MAX_TRANSCRIPTS;
  return (
    `A review can include at most ${MAX_TRANSCRIPTS} transcripts; you added ` +
    `${transcriptCount}. Remove ${over} to continue.`
  );
}

/**
 * First file over the per-file ceiling, or null. Returns the offending filename
 * so the caller can flag that exact file.
 */
export function fileSizeError(files: SizedFile[]): { filename: string; message: string } | null {
  for (const f of files) {
    if (f.bytes > MAX_FILE_BYTES) {
      return {
        filename: f.filename,
        message:
          `${f.filename} is ${formatKb(f.bytes)}, over the ${formatKb(MAX_FILE_BYTES)} ` +
          `limit for a single file. Shorten it or split it, then try again.`,
      };
    }
  }
  return null;
}

/** Total over the per-review budget? Returns a clear message, or null. */
export function totalSizeError(files: SizedFile[]): string | null {
  const total = files.reduce((sum, f) => sum + f.bytes, 0);
  if (total <= MAX_TOTAL_BYTES) return null;
  return (
    `These files total ${formatKb(total)}, over the ${formatKb(MAX_TOTAL_BYTES)} ` +
    `limit for one review. Remove or shorten some files, then try again.`
  );
}
