import assert from "node:assert/strict";
import { test } from "node:test";

import { indexRepoTree, repoFolderName } from "./repo-files.ts";

test("indexes each folder's children, sorted, with .git left out", () => {
  const index = indexRepoTree([
    { path: "src", type: "dir" },
    { path: "src/b.py", type: "file" },
    { path: "src/a.py", type: "file" },
    { path: "README.md", type: "file" },
    { path: ".git/config", type: "file" },
    { path: ".github/ci.yml", type: "file" },
  ]);
  assert.deepEqual(index.children.get(""), [
    [".github", "dir"],
    ["README.md", "file"],
    ["src", "dir"],
  ]);
  assert.deepEqual(index.children.get("src"), [
    ["a.py", "file"],
    ["b.py", "file"],
  ]);
  assert.equal(index.files.has(".git/config"), false);
  assert.equal(index.files.has("src/a.py"), true);
});

test("a file listed without its folders still gets them", () => {
  const index = indexRepoTree([{ path: "a/b/c.txt", type: "file" }]);
  assert.deepEqual(index.children.get(""), [["a", "dir"]]);
  assert.deepEqual(index.children.get("a"), [["b", "dir"]]);
  assert.deepEqual(index.children.get("a/b"), [["c.txt", "file"]]);
});

test("the repository folder never collides with a workspace entry", () => {
  assert.equal(repoFolderName("acme/widgets", new Set(["run.py"])), "widgets");
  assert.equal(repoFolderName("acme/run.py", new Set(["run.py", "run.py-2"])), "run.py-3");
});
