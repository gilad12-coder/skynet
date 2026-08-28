import { test } from "node:test";
import assert from "node:assert/strict";
import { countChanges, diffLines, diffRows, diffWords } from "./blackbox-diff.ts";

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
