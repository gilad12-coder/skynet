export interface DiffLine {
  text: string;
  kind: "same" | "added" | "removed";
}

export interface DiffSegment {
  text: string;
  changed: boolean;
}

export interface DiffRow {
  kind: DiffLine["kind"];
  segments: DiffSegment[];
}

// Beyond this many cell comparisons the quadratic LCS table stops being worth
// it for a read-only view; the fallback shows the texts as replaced wholesale.
const MAX_LCS_CELLS = 4_000_000;

// Callers only index within bounds; this keeps noUncheckedIndexedAccess quiet
// without sprinkling non-null assertions through the loops.
function at<T>(xs: readonly T[], i: number): T {
  return xs[i] as T;
}

function lcsDiff<T>(
  a: readonly T[],
  b: readonly T[],
  same: (x: T, y: T) => boolean,
): Array<{ item: T; kind: DiffLine["kind"] }> {
  const n = a.length;
  const m = b.length;
  if ((n + 1) * (m + 1) > MAX_LCS_CELLS) {
    return [
      ...a.map((item) => ({ item, kind: "removed" as const })),
      ...b.map((item) => ({ item, kind: "added" as const })),
    ];
  }
  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);
  const cell = (i: number, j: number): number => dp[i * width + j] ?? 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] = same(at(a, i), at(b, j))
        ? cell(i + 1, j + 1) + 1
        : Math.max(cell(i + 1, j), cell(i, j + 1));
    }
  }
  const out: Array<{ item: T; kind: DiffLine["kind"] }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (same(at(a, i), at(b, j))) {
      out.push({ item: at(a, i), kind: "same" });
      i++;
      j++;
    } else if (cell(i + 1, j) >= cell(i, j + 1)) {
      out.push({ item: at(a, i), kind: "removed" });
      i++;
    } else {
      out.push({ item: at(b, j), kind: "added" });
      j++;
    }
  }
  while (i < n) out.push({ item: at(a, i++), kind: "removed" });
  while (j < m) out.push({ item: at(b, j++), kind: "added" });
  return out;
}

/** Line-level diff of two texts; within a hunk, removed lines come before added ones. */
export function diffLines(before: string, after: string): DiffLine[] {
  if (before === after) return before.split("\n").map((text) => ({ text, kind: "same" }));
  return lcsDiff(before.split("\n"), after.split("\n"), (x, y) => x === y).map(
    ({ item, kind }) => ({ text: item, kind }),
  );
}

function tokens(line: string): string[] {
  return line.split(/(\s+)/).filter((t) => t.length > 0);
}

function mergeSegments(parts: DiffSegment[]): DiffSegment[] {
  const out: DiffSegment[] = [];
  for (const part of parts) {
    const last = out[out.length - 1];
    if (last && last.changed === part.changed) last.text += part.text;
    else out.push({ ...part });
  }
  return out;
}

/** Word-level segments for a replaced line pair: what the old line lost and what the new line gained. */
export function diffWords(before: string, after: string): [DiffSegment[], DiffSegment[]] {
  const steps = lcsDiff(tokens(before), tokens(after), (x, y) => x === y);
  const left: DiffSegment[] = [];
  const right: DiffSegment[] = [];
  for (const { item, kind } of steps) {
    if (kind !== "added") left.push({ text: item, changed: kind === "removed" });
    if (kind !== "removed") right.push({ text: item, changed: kind === "added" });
  }
  return [mergeSegments(left), mergeSegments(right)];
}

/**
 * Line diff shaped for rendering. When a hunk replaces N lines with N lines
 * the pairs are compared word by word so the changed words stand out; other
 * hunks keep whole-line highlighting.
 */
export function diffRows(before: string, after: string): DiffRow[] {
  const lines = diffLines(before, after);
  const rows: DiffRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = at(lines, i);
    if (line.kind !== "removed") {
      rows.push({ kind: line.kind, segments: [{ text: line.text, changed: false }] });
      i++;
      continue;
    }
    let removedEnd = i;
    while (removedEnd < lines.length && at(lines, removedEnd).kind === "removed") removedEnd++;
    let addedEnd = removedEnd;
    while (addedEnd < lines.length && at(lines, addedEnd).kind === "added") addedEnd++;
    const removed = lines.slice(i, removedEnd);
    const added = lines.slice(removedEnd, addedEnd);
    if (removed.length === added.length) {
      const pairs = removed.map((r, k) => diffWords(r.text, at(added, k).text));
      pairs.forEach(([left]) => rows.push({ kind: "removed", segments: left }));
      pairs.forEach(([, right]) => rows.push({ kind: "added", segments: right }));
    } else {
      for (const l of [...removed, ...added]) {
        rows.push({ kind: l.kind, segments: [{ text: l.text, changed: false }] });
      }
    }
    i = addedEnd;
  }
  return rows;
}

export function countChanges(rows: DiffRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.kind === "added") added++;
    else if (row.kind === "removed") removed++;
  }
  return { added, removed };
}
