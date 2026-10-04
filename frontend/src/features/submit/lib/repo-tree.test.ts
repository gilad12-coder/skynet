import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildRepoTree,
  checkState,
  findNode,
  foldersToReveal,
  togglePath,
  WHOLE_REPOSITORY,
} from "./repo-tree.ts";

const ENTRIES = [
  { path: "README.md", type: "file" as const },
  { path: "src", type: "dir" as const },
  { path: "src/app.py", type: "file" as const },
  { path: "src/lib/util.py", type: "file" as const },
  { path: "src/lib/io.py", type: "file" as const },
  { path: "docs/index.md", type: "file" as const },
];
const roots = buildRepoTree(ENTRIES);
const node = (path: string) => findNode(roots, path)!;

test("the tree nests folders first, then files, each sorted, inventing missing folders", () => {
  assert.deepEqual(
    roots.map((n) => n.path),
    ["docs", "src", "README.md"],
  );
  assert.deepEqual(
    node("src").children.map((n) => n.path),
    ["src/lib", "src/app.py"],
  );
  assert.deepEqual(
    node("src/lib").children.map((n) => n.name),
    ["io.py", "util.py"],
  );
});

test("a folder covers everything below it and reads mixed when partly chosen", () => {
  assert.equal(checkState(node("src/lib/io.py"), ["src"]), "checked");
  assert.equal(checkState(node("src"), ["src/lib/io.py"]), "mixed");
  assert.equal(checkState(node("docs"), ["src/lib/io.py"]), "unchecked");
  assert.equal(checkState(node("docs/index.md"), [WHOLE_REPOSITORY]), "checked");
});

test("checking a folder replaces the paths it covers", () => {
  assert.deepEqual(togglePath(["src/app.py", "docs"], node("src"), roots), ["docs", "src"]);
});

test("unchecking a covered node keeps everything else its folder covered", () => {
  assert.deepEqual(togglePath([WHOLE_REPOSITORY], node("src/lib/io.py"), roots), [
    "docs",
    "README.md",
    "src/app.py",
    "src/lib/util.py",
  ]);
  assert.deepEqual(togglePath(["src", "docs"], node("src/app.py"), roots), ["docs", "src/lib"]);
});

test("unchecking a chosen path removes it", () => {
  assert.deepEqual(togglePath(["src", "docs"], node("src"), roots), ["docs"]);
});

test("folders holding a chosen path open", () => {
  assert.deepEqual(foldersToReveal(["src/lib/io.py", "docs"]), ["src", "src/lib"]);
});
