import assert from "node:assert/strict";
import { test } from "node:test";

import { firstChangedLine, openTarget, pendingOpens } from "./open-file.ts";

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

test("a written file opens on its first changed line", () => {
  assert.equal(firstChangedLine("a\nb\nc", "a\nB\nc"), 2);
  assert.equal(firstChangedLine("", "def score():\n    pass"), 1);
  assert.equal(firstChangedLine("a\nb\nc", "a\nb"), 2);
  assert.equal(firstChangedLine("a\nb", "a\nb\nc"), 3);
  assert.equal(firstChangedLine("same", "same"), undefined);
});

test("every file asked for in one batch opens, in order", () => {
  const requests = [{ path: "metric.py", line: 1 }, { path: "ghost.py" }, { path: "run.py", line: 2 }];
  assert.deepEqual(pendingOpens(requests, 0, TEXTS), [
    { path: "metric.py", line: 1 },
    { path: "run.py", line: 2 },
  ]);
  assert.deepEqual(pendingOpens(requests, 2, TEXTS), [{ path: "run.py", line: 2 }]);
  assert.deepEqual(pendingOpens(requests, 3, TEXTS), []);
});
