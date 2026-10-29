import { test } from "node:test";
import assert from "node:assert/strict";
import { pickerRows } from "./facet-options.ts";

test("pickerRows pins the selection first, without a count when it is outside the ranked slice", () => {
  const rows = pickerRows(
    [
      { value: "gpt-4o", count: 9 },
      { value: "claude", count: 4 },
    ],
    ["rare-model", "claude"],
  );
  assert.deepEqual(rows, [
    { value: "rare-model", count: null, checked: true },
    { value: "claude", count: 4, checked: true },
    { value: "gpt-4o", count: 9, checked: false },
  ]);
});
