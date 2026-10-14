import assert from "node:assert/strict";
import { test } from "node:test";

import { appendVersion } from "./artifact-versions.ts";

test("a lane's code landing at its end and again at the turn's end is one version", () => {
  let versions = appendVersion([], "def run(): ...", 100);
  versions = appendVersion(versions, "def run(): ...", 900);
  assert.deepEqual(versions, [{ code: "def run(): ...", ts: 100 }]);
});

test("changed code adds a version, and empty code adds none", () => {
  const first = appendVersion([], "a", 1);
  assert.equal(appendVersion(first, "  ", 2), first);
  assert.deepEqual(appendVersion(first, "b", 3), [
    { code: "a", ts: 1 },
    { code: "b", ts: 3 },
  ]);
});
