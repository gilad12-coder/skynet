import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ancestors,
  buildRepoTree,
  changedFolders,
  hasFile,
  repoFileKind,
  visibleRows,
} from "./repo-browser.ts";
import { parsePatch } from "./repo-patch.ts";

const ENTRIES = [
  { path: "README.md", type: "file" as const, size: 10 },
  { path: "src", type: "dir" as const, size: null },
  { path: "src/app.py", type: "file" as const, size: 20 },
  { path: "src/old.py", type: "file" as const, size: 5 },
  { path: "docs", type: "dir" as const, size: null },
  { path: "docs/guide.md", type: "file" as const, size: 5 },
];

const PATCH = [
  "diff --git a/src/app.py b/src/app.py",
  "--- a/src/app.py",
  "+++ b/src/app.py",
  "@@ -1 +1 @@",
  "-x",
  "+y",
  "diff --git a/src/old.py b/src/old.py",
  "deleted file mode 100644",
  "--- a/src/old.py",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-gone",
  "diff --git a/src/new/mod.py b/src/new/mod.py",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/new/mod.py",
  "@@ -0,0 +1 @@",
  "+hi",
].join("\n");

const root = buildRepoTree(ENTRIES, parsePatch(PATCH));

test("buildRepoTree lists folders before files and adds the patch's new files", () => {
  assert.deepEqual(
    root.children.map((c) => c.name),
    ["docs", "src", "README.md"],
  );
  const src = root.children.find((c) => c.name === "src");
  assert.deepEqual(
    src?.children.map((c) => c.name),
    ["new", "app.py", "old.py"],
  );
  assert.equal(src?.changedCount, 3);
});

test("buildRepoTree marks deleted files as removed", () => {
  const src = root.children.find((c) => c.name === "src");
  const old = src?.children.find((c) => c.name === "old.py");
  assert.equal(old?.removed, true);
  assert.equal(old?.change?.status, "deleted");
});

test("changedFolders opens only folders holding a change", () => {
  assert.deepEqual([...changedFolders(root)].sort(), ["src", "src/new"]);
});

test("visibleRows hides collapsed folders' children", () => {
  const rows = visibleRows(root, new Set(["src"]), "");
  assert.deepEqual(
    rows.map((r) => [r.node.path, r.depth]),
    [
      ["docs", 0],
      ["src", 0],
      ["src/new", 1],
      ["src/app.py", 1],
      ["src/old.py", 1],
      ["README.md", 0],
    ],
  );
});

test("visibleRows filters by path and opens the matches' folders", () => {
  const rows = visibleRows(root, new Set(), "GUIDE");
  assert.deepEqual(
    rows.map((r) => [r.node.path, r.expanded]),
    [
      ["docs", true],
      ["docs/guide.md", false],
    ],
  );
  assert.deepEqual(visibleRows(root, new Set(), "nothing-like-this"), []);
});

test("hasFile finds files, not folders", () => {
  assert.equal(hasFile(root, "src/new/mod.py"), true);
  assert.equal(hasFile(root, "src"), false);
  assert.equal(hasFile(root, "src/missing.py"), false);
});

test("ancestors lists the folders above a path", () => {
  assert.deepEqual(ancestors("a/b/c.txt"), ["a", "a/b"]);
  assert.deepEqual(ancestors("c.txt"), []);
});

test("repoFileKind reads the extension", () => {
  assert.equal(repoFileKind("docs/README.MD"), "markdown");
  assert.equal(repoFileKind("site/index.html"), "html");
  assert.equal(repoFileKind("a.py"), "python");
  assert.equal(repoFileKind("Makefile"), "code");
});
