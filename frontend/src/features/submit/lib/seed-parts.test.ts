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

test("unnamed content receives identifiers without colliding with authored names", async () => {
  const { namedSeedParts } = await import("./seed-parts.ts");
  const parts = namedSeedParts([
    { key: "", value: "first" },
    { key: "part_1", value: "existing" },
    { key: "", value: "second" },
    { key: "", value: "" },
  ]);
  assert.deepEqual(parts.map((part) => part.key), ["part_2", "part_1", "part_3", ""]);
  assert.equal(seedPartsIssue(parts), null);
  assert.deepEqual(parts.map((part) => part.value), ["first", "existing", "second", ""]);
});
