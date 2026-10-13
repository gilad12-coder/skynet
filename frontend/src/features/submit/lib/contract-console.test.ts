import assert from "node:assert/strict";
import { test } from "node:test";

import type { ContractCheckItem, ContractCheckResponse } from "@/shared/types/unified-run";
import { contractConsole, contractSampleRows, contractStaticChecks } from "./contract-console.ts";

function item(key: string, status: "passed" | "failed", sample_index: number | null = null) {
  return { key, status, message: key, sample_index, detail: null } as unknown as ContractCheckItem;
}

const result = {
  ok: false,
  optimizer_resolved: "gepa",
  checks: [
    item("workspace.run", "passed"),
    item("metric.signature", "failed"),
    item("workspace.run", "failed", 0),
    item("metric.shape", "passed", 0),
  ],
  samples: [{ index: 0, input_preview: "in" }],
} as unknown as ContractCheckResponse;

test("each editor's console shows only its own failures", () => {
  const line = (i: ContractCheckItem) => i.key;
  assert.deepEqual(contractConsole(result, "run", line), {
    valid: false,
    errors: ["workspace.run"],
    warnings: [],
  });
  assert.deepEqual(contractConsole(result, "metric", line)?.errors, ["metric.signature"]);
  assert.equal(contractConsole(null, "run", line), null);
});

test("a sample row carries its failed checks inline", () => {
  const [row] = contractSampleRows(result);
  assert.equal(row?.sample.index, 0);
  assert.deepEqual(
    row?.failures.map((f) => f.key),
    ["workspace.run"],
  );
  assert.deepEqual(
    contractStaticChecks(result).map((c) => c.key),
    ["workspace.run", "metric.signature"],
  );
});
