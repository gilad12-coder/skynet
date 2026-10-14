import assert from "node:assert/strict";
import { test } from "node:test";

import { createCodeDrafts } from "./code-drafts.ts";

test("streamed pieces build the editor's code as the model writes it", () => {
  const drafts = createCodeDrafts();
  assert.equal(drafts.write("signature", "def run(", true), "def run(");
  assert.equal(drafts.write("signature", "artifact, input):", false), "def run(artifact, input):");
  // The other editor drafts on its own.
  assert.equal(drafts.write("metric", "def score(", true), "def score(");
  assert.equal(
    drafts.write("signature", "\n    return 1", false),
    "def run(artifact, input):\n    return 1",
  );
});

test("a retried edit starts its draft over", () => {
  const drafts = createCodeDrafts();
  drafts.write("metric", "broken", true);
  assert.equal(drafts.write("metric", "fixed", true), "fixed");
});

test("a landed edit closes its draft, so nothing is rolled back after it", () => {
  const drafts = createCodeDrafts();
  drafts.write("signature", "def run(): ...", true);
  drafts.land("signature");
  assert.equal(drafts.drop("signature"), false);
});

test("an edit that never lands reports its open draft once", () => {
  const drafts = createCodeDrafts();
  assert.equal(drafts.drop("metric"), false);
  drafts.write("metric", "def score(", true);
  assert.equal(drafts.drop("metric"), true);
  assert.equal(drafts.drop("metric"), false);
});
