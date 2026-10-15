import assert from "node:assert/strict";
import { test } from "node:test";

import { openTarget } from "./open-file.ts";

const TEXTS = { "run.py": "a\nb\nc\n", "metric.py": "def metric():\n    return 1" };

test("a known file opens at its line", () => {
  assert.deepEqual(openTarget({ path: "metric.py", line: 2 }, TEXTS), { path: "metric.py", line: 2 });
});

test("a file the workspace does not hold opens nothing", () => {
  assert.equal(openTarget({ path: "ghost.py", line: 1 }, TEXTS), null);
  assert.equal(openTarget({ path: "constructor" }, TEXTS), null);
});

test("no line, or a non-positive one, opens the file without moving the cursor", () => {
  assert.deepEqual(openTarget({ path: "run.py" }, TEXTS), { path: "run.py" });
  assert.deepEqual(openTarget({ path: "run.py", line: 0 }, TEXTS), { path: "run.py" });
  assert.deepEqual(openTarget({ path: "run.py", line: Number.NaN }, TEXTS), { path: "run.py" });
});

test("a line past the end lands on the last line", () => {
  assert.deepEqual(openTarget({ path: "metric.py", line: 40 }, TEXTS), { path: "metric.py", line: 2 });
  assert.deepEqual(openTarget({ path: "run.py", line: 2.7 }, TEXTS), { path: "run.py", line: 2 });
});
