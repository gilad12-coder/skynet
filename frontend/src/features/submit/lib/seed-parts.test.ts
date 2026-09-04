import assert from "node:assert/strict";
import { test } from "node:test";
import { seedPartsIssue } from "./seed-parts.ts";

test("part names cannot silently overwrite another authored part", () => {
  assert.equal(
    seedPartsIssue([
      { key: "prompt", value: "first" },
      { key: " prompt ", value: "second" },
    ]),
    "duplicate_name",
  );
  assert.equal(seedPartsIssue([{ key: "", value: "authored text" }]), "missing_name");
  assert.equal(seedPartsIssue([{ key: "prompt", value: " " }]), "missing_content");
  assert.equal(
    seedPartsIssue([
      { key: "prompt", value: "first" },
      { key: "other", value: "second" },
      { key: "", value: "" },
    ]),
    null,
  );
});
