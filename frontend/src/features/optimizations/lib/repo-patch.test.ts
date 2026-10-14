import { test } from "node:test";
import assert from "node:assert/strict";
import { applyFilePatch, parsePatch, unquotePath, type FilePatch } from "./repo-patch.ts";

// Verbatim `git diff --cached --binary --no-color -M` output, the form
// repository versions are recorded in.
const PATCH = [
  "diff --git a/bin.dat b/bin.dat",
  "new file mode 100644",
  "index 0000000000000000000000000000000000000000..8352675d67aed6625ece79af41c27fdb4ee2e867",
  "GIT binary patch",
  "literal 3",
  "KcmZQzWC8#H2LJ>B",
  "",
  "literal 0",
  "HcmV?d00001",
  "",
  'diff --git "a/dir/\\303\\274.txt" "b/dir/\\303\\274.txt"',
  "new file mode 100644",
  "index 0000000..9c38d10",
  "--- /dev/null",
  '+++ "b/dir/\\303\\274.txt"',
  "@@ -0,0 +1,2 @@",
  "+new",
  "+file",
  "\\ No newline at end of file",
  "diff --git a/gone.txt b/gone.txt",
  "deleted file mode 100644",
  "index 3367afd..0000000",
  "--- a/gone.txt",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-old",
  "diff --git a/keep.py b/keep.py",
  "index 71ac1b5..f8638e5 100644",
  "--- a/keep.py",
  "+++ b/keep.py",
  "@@ -1,8 +1,9 @@",
  " a",
  "-b",
  "+B",
  " c",
  " d",
  " e",
  " f",
  " g",
  "-h",
  "+H",
  "+I",
  "diff --git a/old_name.py b/new_name.py",
  "similarity index 60%",
  "rename from old_name.py",
  "rename to new_name.py",
  "index 74c047b..50fda4f 100644",
  "--- a/old_name.py",
  "+++ b/new_name.py",
  "@@ -1,3 +1,3 @@",
  " r1",
  " r2",
  "-r3",
  "+r3x",
  "diff --git a/noeol.txt b/noeol.txt",
  "index 9ed40b4..814f4a4 100644",
  "--- a/noeol.txt",
  "+++ b/noeol.txt",
  "@@ -1,2 +1,2 @@",
  " one",
  "-two",
  "\\ No newline at end of file",
  "+two",
  "diff --git a/sp ace.md b/sp ace.md",
  "index b77b4eb..206b378 100644",
  "--- a/sp ace.md\t",
  "+++ b/sp ace.md\t",
  "@@ -1,2 +1,2 @@",
  " x",
  "-y",
  "+z",
  "",
].join("\n");

function byPath(files: FilePatch[], path: string): FilePatch {
  const file = files.find((f) => f.path === path);
  assert.ok(file, `no entry for ${path}`);
  return file;
}

test("parsePatch splits a multi-file diff in patch order", () => {
  const files = parsePatch(PATCH);
  assert.deepEqual(
    files.map((f) => [f.path, f.status, f.added, f.removed]),
    [
      ["bin.dat", "added", 0, 0],
      ["dir/ü.txt", "added", 2, 0],
      ["gone.txt", "deleted", 0, 1],
      ["keep.py", "modified", 3, 2],
      ["new_name.py", "renamed", 1, 1],
      ["noeol.txt", "modified", 1, 1],
      ["sp ace.md", "modified", 1, 1],
    ],
  );
});

test("parsePatch reads binary, new, deleted and renamed entries", () => {
  const files = parsePatch(PATCH);
  assert.equal(byPath(files, "bin.dat").binary, true);
  assert.equal(byPath(files, "bin.dat").hunks.length, 0);
  assert.equal(byPath(files, "dir/ü.txt").oldPath, null);
  assert.equal(byPath(files, "gone.txt").oldPath, "gone.txt");
  assert.equal(byPath(files, "new_name.py").oldPath, "old_name.py");
  assert.equal(byPath(files, "keep.py").binary, false);
});

test("parsePatch keeps each file's own section as its raw patch", () => {
  const raw = byPath(parsePatch(PATCH), "gone.txt").raw;
  assert.ok(raw.startsWith("diff --git a/gone.txt b/gone.txt"));
  assert.ok(raw.endsWith("-old"));
  assert.ok(!raw.includes("keep.py"));
});

test("parsePatch returns nothing for an empty patch", () => {
  assert.deepEqual(parsePatch(""), []);
  assert.deepEqual(parsePatch("\n"), []);
});

test("parsePatch defaults a hunk's omitted line count to 1", () => {
  const hunk = byPath(parsePatch(PATCH), "gone.txt").hunks[0];
  assert.deepEqual(
    hunk && [hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines],
    [1, 1, 0, 0],
  );
});

test("unquotePath decodes git's octal UTF-8 escapes", () => {
  assert.equal(unquotePath('"a/dir/\\303\\274.txt"'), "a/dir/ü.txt");
  assert.equal(unquotePath('"tab\\there"'), "tab\there");
  assert.equal(unquotePath("plain/path"), "plain/path");
});

test("applyFilePatch rebuilds a modified file", () => {
  const file = byPath(parsePatch(PATCH), "keep.py");
  assert.deepEqual(applyFilePatch("a\nb\nc\nd\ne\nf\ng\nh\n", file), {
    ok: true,
    text: "a\nB\nc\nd\ne\nf\ng\nH\nI\n",
  });
});

test("applyFilePatch builds a new file from nothing, without a final newline", () => {
  const file = byPath(parsePatch(PATCH), "dir/ü.txt");
  assert.deepEqual(applyFilePatch("", file), { ok: true, text: "new\nfile" });
});

test("applyFilePatch adds the final newline the patch adds", () => {
  const file = byPath(parsePatch(PATCH), "noeol.txt");
  assert.deepEqual(applyFilePatch("one\ntwo", file), { ok: true, text: "one\ntwo\n" });
});

test("applyFilePatch empties a deleted file and edits a renamed one", () => {
  const files = parsePatch(PATCH);
  assert.deepEqual(applyFilePatch("old\n", byPath(files, "gone.txt")), { ok: true, text: "" });
  assert.deepEqual(applyFilePatch("r1\nr2\nr3\n", byPath(files, "new_name.py")), {
    ok: true,
    text: "r1\nr2\nr3x\n",
  });
});

test("applyFilePatch keeps the lines a hunk doesn't cover", () => {
  const [file] = parsePatch(
    [
      "diff --git a/f.txt b/f.txt",
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -2,1 +2,1 @@",
      "-2",
      "+two",
      "@@ -4,0 +5 @@",
      "+four-and-a-half",
    ].join("\n"),
  );
  assert.ok(file);
  assert.deepEqual(applyFilePatch("1\n2\n3\n4\n5\n", file), {
    ok: true,
    text: "1\ntwo\n3\n4\nfour-and-a-half\n5\n",
  });
});

test("applyFilePatch refuses a hunk whose lines don't match the base", () => {
  const file = byPath(parsePatch(PATCH), "keep.py");
  const result = applyFilePatch("a\nchanged\nc\nd\ne\nf\ng\nh\n", file);
  assert.equal(result.ok, false);
});

test("applyFilePatch refuses a hunk past the end of the base", () => {
  const file = byPath(parsePatch(PATCH), "keep.py");
  assert.equal(applyFilePatch("a\n", file).ok, false);
});

test("applyFilePatch refuses a binary entry", () => {
  const file = byPath(parsePatch(PATCH), "bin.dat");
  assert.equal(applyFilePatch("", file).ok, false);
});
