import assert from "node:assert/strict";
import { test } from "node:test";

import type { ContractCheckItem, ContractCheckResponse } from "@/shared/types/unified-run";
import { checkFile, contractConsole } from "./contract-console.ts";

function item(
  key: string,
  status: "passed" | "failed",
  sample_index: number | null = null,
  extra: Partial<ContractCheckItem> = {},
) {
  return { key, status, message: key, sample_index, detail: null, ...extra } as unknown as ContractCheckItem;
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

test("each file's console shows only its own failures", () => {
  const line = (i: ContractCheckItem) => i.key;
  assert.deepEqual(contractConsole(result, "run.py", line), {
    valid: false,
    errors: ["workspace.run"],
    warnings: [],
  });
  assert.deepEqual(contractConsole(result, "metric.py", line)?.errors, ["metric.signature"]);
  assert.deepEqual(contractConsole(result, "helpers.py", line, ["helpers.py"]), {
    valid: true,
    errors: [],
    warnings: [],
  });
  assert.equal(contractConsole(null, "run.py", line), null);
});

test("a file item maps to the file it names", () => {
  const bad = item("workspace.files", "failed", null, {
    message_params: { path: "lib/parse.py", error: "invalid syntax" },
  });
  assert.equal(checkFile(bad, ["lib/parse.py"]), "lib/parse.py");
  assert.equal(checkFile(item("workspace.files", "failed")), "run.py");
});

test("a run failure maps to the helper its traceback ends in", () => {
  const detail = [
    "Traceback (user code):",
    '  File "<run_code>", line 4, in run',
    '  File "helpers.py", line 2, in shout',
    "ZeroDivisionError: division by zero",
  ].join("\n");
  const failed = item("workspace.run", "failed", 0, { detail });
  assert.equal(checkFile(failed, ["helpers.py"]), "helpers.py");
  // An unknown file in the traceback is not a workspace file.
  assert.equal(checkFile(failed, []), "run.py");
  assert.equal(checkFile(failed, ["other.py"]), "run.py");
});

test("a run failure back in run.py after a helper stays with run.py", () => {
  const detail = [
    "Traceback (user code):",
    '  File "<run_code>", line 4, in run',
    '  File "helpers.py", line 2, in apply',
    '  File "<run_code>", line 2, in step',
    "KeyError: 'q'",
  ].join("\n");
  assert.equal(checkFile(item("workspace.run", "failed", 0, { detail }), ["helpers.py"]), "run.py");
});

test("lint lands on its own file, warnings stay warnings", () => {
  const linted = {
    ...result,
    checks: [],
    files: [
      { path: "run.py", errors: [], warnings: ["run.py:1:8 F401 `os` imported but unused"] },
      { path: "helpers.py", errors: ["helpers.py:2:5 F821 Undefined name `x`"], warnings: [] },
    ],
  } as unknown as ContractCheckResponse;
  const line = (i: ContractCheckItem) => i.key;
  assert.deepEqual(contractConsole(linted, "run.py", line), {
    valid: true,
    errors: [],
    warnings: ["run.py:1:8 F401 `os` imported but unused"],
  });
  assert.equal(contractConsole(linted, "helpers.py", line, ["helpers.py"])?.valid, false);
});
