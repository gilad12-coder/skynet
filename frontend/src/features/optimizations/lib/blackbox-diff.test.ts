import { test } from "node:test";
import assert from "node:assert/strict";
import {
  countChanges,
  diffLines,
  diffRows,
  diffWords,
  foldRows,
  fullDiffRows,
  numberRows,
} from "./blackbox-diff.ts";

test("diffLines keeps identical texts as same lines", () => {
  assert.deepEqual(diffLines("a\nb", "a\nb"), [
    { text: "a", kind: "same" },
    { text: "b", kind: "same" },
  ]);
});

test("diffLines reports insertions, deletions and replacements in order", () => {
  assert.deepEqual(diffLines("a\nb\nc", "a\nx\nc\nd"), [
    { text: "a", kind: "same" },
    { text: "b", kind: "removed" },
    { text: "x", kind: "added" },
    { text: "c", kind: "same" },
    { text: "d", kind: "added" },
  ]);
});

test("diffLines treats an empty seed as all additions", () => {
  assert.deepEqual(diffLines("", "one\ntwo"), [
    { text: "", kind: "removed" },
    { text: "one", kind: "added" },
    { text: "two", kind: "added" },
  ]);
});

test("diffWords isolates the words that changed and keeps whitespace", () => {
  const [left, right] = diffWords("You are a helpful assistant.", "You are a concise assistant.");
  assert.deepEqual(left, [
    { text: "You are a ", changed: false },
    { text: "helpful", changed: true },
    { text: " assistant.", changed: false },
  ]);
  assert.deepEqual(right, [
    { text: "You are a ", changed: false },
    { text: "concise", changed: true },
    { text: " assistant.", changed: false },
  ]);
});

test("diffRows highlights words for balanced replacements and whole lines otherwise", () => {
  const rows = diffRows("keep\nold line here\nkeep", "keep\nnew line here\nkeep");
  assert.deepEqual(
    rows.map((r) => r.kind),
    ["same", "removed", "added", "same"],
  );
  assert.deepEqual(rows[1].segments, [
    { text: "old", changed: true },
    { text: " line here", changed: false },
  ]);
  assert.deepEqual(rows[2].segments, [
    { text: "new", changed: true },
    { text: " line here", changed: false },
  ]);

  const unbalanced = diffRows("one", "one\ntwo\nthree");
  assert.equal(
    unbalanced.every((r) => r.segments.every((s) => !s.changed)),
    true,
  );
  assert.deepEqual(countChanges(unbalanced), { added: 2, removed: 0 });
});

test("fullDiffRows keeps every unchanged line around the change", () => {
  const rows = fullDiffRows("1\n2\n3\n4\n5", "1\n2\nthree\n4\n5");
  assert.deepEqual(
    rows.map((r) => [r.kind, r.segments.map((s) => s.text).join("")]),
    [
      ["same", "1"],
      ["same", "2"],
      ["removed", "3"],
      ["added", "three"],
      ["same", "4"],
      ["same", "5"],
    ],
  );
});

test("fullDiffRows shows a new file as all added and a deleted one as all removed", () => {
  assert.deepEqual(
    fullDiffRows("", "a\nb").map((r) => r.kind),
    ["added", "added"],
  );
  assert.deepEqual(
    fullDiffRows("a\nb", "").map((r) => r.kind),
    ["removed", "removed"],
  );
});

const numbered = (n: number) => Array.from({ length: n }, (_, i) => `l${i + 1}`).join("\n");

test("foldRows keeps context around a change and folds the rest", () => {
  const before = numbered(20);
  const after = before.replace("l10\n", "L10\n");
  const folded = foldRows(numberRows(fullDiffRows(before, after)), 2);
  const gaps = folded.filter((r) => "gap" in r);
  assert.equal(gaps.length, 2);
  assert.deepEqual(
    gaps.map((g) => ("gap" in g ? g.hidden : 0)),
    [7, 8],
  );
  const shown = folded.filter((r) => !("gap" in r));
  assert.deepEqual(
    shown.map((r) => ("gap" in r ? "" : `${r.kind}:${r.oldLine ?? "-"}/${r.newLine ?? "-"}`)),
    ["same:8/8", "same:9/9", "removed:10/-", "added:-/10", "same:11/11", "same:12/12"],
  );
});

test("foldRows opens an expanded gap", () => {
  const before = numbered(12);
  const after = `${before}\nnew`;
  const rows = numberRows(fullDiffRows(before, after));
  const [gap] = foldRows(rows, 1);
  assert.ok(gap && "gap" in gap);
  assert.equal(foldRows(rows, 1, new Set([gap.start])).length, rows.length);
});

test("foldRows returns a single gap for an unchanged file", () => {
  const rows = numberRows(fullDiffRows("a\nb", "a\nb"));
  assert.deepEqual(foldRows(rows), [{ gap: true, start: 0, hidden: 2 }]);
});
