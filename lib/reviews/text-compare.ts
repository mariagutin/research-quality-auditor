// Deterministic word-level comparison, shared by the checker (to find a reworded
// "possible source" passage) and the UI (to highlight exactly which words differ).
//
// Everything here is pure (text in, data out) so it is directly testable.
//
// Design notes (see ADR-0006):
//   - Words are compared NORMALIZED: lowercased, with leading/trailing punctuation
//     stripped. So "Time." and "time" are the same word; casing and surrounding
//     punctuation are not treated as wording differences.
//   - "In order" overlap is measured with a word-level Longest Common Subsequence
//     (LCS). Similarity = 2*LCS / (wordsA + wordsB) -- 1.0 when identical, lower
//     when words are inserted, removed, substituted, or reordered.
//   - An EXACT match means the quote's words appear as a contiguous run inside the
//     passage (verbatim up to case/punctuation); that is checked separately.

export interface Seg {
  text: string; // the original slice, verbatim (word or whitespace run)
  isWord: boolean; // true for a real word (has at least one letter/number)
  norm: string; // normalized form used for comparison ("" for whitespace)
}

// Split text into verbatim segments, alternating words and whitespace, so that
// re-joining the `text` fields reproduces the input exactly (nothing is lost).
export function segmentText(text: string): Seg[] {
  const out: Seg[] = [];
  for (const part of text.split(/(\s+)/)) {
    if (part.length === 0) continue;
    if (/^\s+$/.test(part)) {
      out.push({ text: part, isWord: false, norm: "" });
      continue;
    }
    const norm = part
      .toLowerCase()
      .replace(/^[^\p{L}\p{N}]+/u, "")
      .replace(/[^\p{L}\p{N}]+$/u, "");
    out.push({ text: part, isWord: norm.length > 0, norm });
  }
  return out;
}

// The normalized words of a passage, in order.
export function wordNorms(text: string): string[] {
  return segmentText(text)
    .filter((s) => s.isWord)
    .map((s) => s.norm);
}

// LCS of two word sequences: which indices on each side take part in a longest
// common subsequence, and its length.
function lcsMatch(a: string[], b: string[]): {
  aMatched: boolean[];
  bMatched: boolean[];
  length: number;
} {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const aMatched = new Array(n).fill(false);
  const bMatched = new Array(m).fill(false);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      aMatched[i] = true;
      bMatched[j] = true;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return { aMatched, bMatched, length: dp[0]?.[0] ?? 0 };
}

// Similarity in [0,1]: 2*LCS / (|a| + |b|). 1.0 means the same words in the same
// order; 0 means nothing in common.
export function similarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const { length } = lcsMatch(a, b);
  return (2 * length) / (a.length + b.length);
}

// True when `needle` appears as a contiguous run of words inside `hay`
// (the quote was said verbatim, up to case/punctuation).
export function contiguousContains(hay: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > hay.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let k = 0; k < needle.length; k++) {
      if (hay[i + k] !== needle[k]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

export interface DiffSeg {
  text: string; // verbatim slice
  changed: boolean; // true when this word is not shared (added/removed/substituted)
}

// Align two passages and mark, on each side, the words that differ. Whitespace
// and punctuation-only runs are preserved verbatim and never marked, so joining
// the `text` fields reproduces each input exactly.
export function diffSegments(aText: string, bText: string): { a: DiffSeg[]; b: DiffSeg[] } {
  const aSeg = segmentText(aText);
  const bSeg = segmentText(bText);
  const { aMatched, bMatched } = lcsMatch(
    aSeg.filter((s) => s.isWord).map((s) => s.norm),
    bSeg.filter((s) => s.isWord).map((s) => s.norm),
  );
  let ai = 0;
  let bi = 0;
  const a = aSeg.map((s) => (s.isWord ? { text: s.text, changed: !aMatched[ai++] } : { text: s.text, changed: false }));
  const b = bSeg.map((s) => (s.isWord ? { text: s.text, changed: !bMatched[bi++] } : { text: s.text, changed: false }));
  return { a, b };
}
