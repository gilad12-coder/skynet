import assert from "node:assert/strict";
import { test } from "node:test";

import { workspaceKey } from "./agent-verdict.ts";

test("the same files give the same key whatever their order", () => {
  assert.equal(
    workspaceKey("run", "metric", { "a.py": "1", "b.py": "2" }),
    workspaceKey("run", "metric", { "b.py": "2", "a.py": "1" }),
  );
});

test("any edit, added or removed file changes the key", () => {
  const base = workspaceKey("run", "metric", { "a.py": "1" });
  assert.notEqual(base, workspaceKey("run ", "metric", { "a.py": "1" }));
  assert.notEqual(base, workspaceKey("run", "metric!", { "a.py": "1" }));
  assert.notEqual(base, workspaceKey("run", "metric", { "a.py": "2" }));
  assert.notEqual(base, workspaceKey("run", "metric", {}));
  assert.notEqual(base, workspaceKey("run", "metric", { "a.py": "1", "b.py": "" }));
});

test("text cannot leak across file boundaries", () => {
  assert.notEqual(workspaceKey("ab", "c", {}), workspaceKey("a", "bc", {}));
});
