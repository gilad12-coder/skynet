import assert from "node:assert/strict";
import { test } from "node:test";

import type { ContractCheckItem, ContractCheckResponse } from "@/shared/types/unified-run";
import {
  CONTRACT_CHECK_PLAN,
  activeContractPhase,
  contractValidation,
} from "./contract-validation.ts";

function item(
  key: string,
  status: ContractCheckItem["status"],
  sample_index: number | null = null,
): ContractCheckItem {
  return { key, status, message: key, sample_index, detail: null } as unknown as ContractCheckItem;
}

function result(ok: boolean, checks: ContractCheckItem[]): ContractCheckResponse {
  return {
    ok,
    optimizer_resolved: "gepa",
    checks,
    samples: [
      { index: 0, input_preview: "a", score: 1 },
      { index: 1, input_preview: "b", score: 0.5 },
    ],
    fingerprint: "fp",
  } as unknown as ContractCheckResponse;
}

const line = (i: ContractCheckItem) => `line:${i.key}`;

test("no check yet shows the plan, not a progress", () => {
  assert.equal(
    contractValidation({ result: null, checking: false, error: null, timing: null, message: line }),
    null,
  );
  assert.deepEqual(CONTRACT_CHECK_PLAN, ["budget", "sandbox", "evaluator"]);
});

test("a running check walks budget, sandbox, then the evaluator step", () => {
  const reserving = contractValidation({
    result: null,
    checking: true,
    error: null,
    timing: { startedAt: 100 },
    message: line,
  });
  assert.equal(reserving?.status, "running");
  assert.deepEqual(reserving?.phases, [{ key: "budget", startedAt: 100, finishedAt: undefined }]);

  const booting = contractValidation({
    result: null,
    checking: true,
    error: null,
    timing: { startedAt: 100, requestAt: 150, sandboxAt: 160 },
    message: line,
  });
  assert.deepEqual(
    booting?.phases.map((p) => [p.key, p.startedAt, p.finishedAt]),
    [
      ["budget", 100, 160],
      ["sandbox", 160, undefined],
    ],
  );

  const scoring = contractValidation({
    result: null,
    checking: true,
    error: null,
    timing: { startedAt: 100, requestAt: 150, sandboxAt: 160, evaluatorAt: 400 },
    message: line,
  });
  assert.deepEqual(
    scoring?.phases.map((p) => [p.key, p.startedAt, p.finishedAt]),
    [
      ["budget", 100, 160],
      ["sandbox", 160, 400],
      ["evaluator", 400, undefined],
    ],
  );
});

test("a restored result reads every step as instant", () => {
  const restored = contractValidation({
    result: result(true, [item("workspace.run", "passed")]),
    checking: false,
    error: null,
    timing: null,
    message: line,
  });
  assert.deepEqual(
    restored?.phases.map((p) => [p.key, p.startedAt, p.finishedAt]),
    [
      ["budget", 0, 0],
      ["sandbox", 0, 0],
      ["evaluator", 0, 0],
    ],
  );
});

test("a check refused before the sandbox woke ends on the budget step", () => {
  const refused = contractValidation({
    result: result(false, [item("workspace.run", "failed")]),
    checking: false,
    error: null,
    timing: { startedAt: 100, requestAt: 150, finishedAt: 300 },
    message: line,
  });
  assert.deepEqual(
    refused?.phases.map((p) => [p.key, p.startedAt, p.finishedAt]),
    [["budget", 100, 300]],
  );
});

test("the compact label follows the step the check stands in", () => {
  assert.equal(activeContractPhase(null, false), null);
  assert.equal(activeContractPhase(null, true), null);
  assert.equal(activeContractPhase({ startedAt: 1 }, true), "budget");
  assert.equal(activeContractPhase({ startedAt: 1, requestAt: 2 }, true), "budget");
  assert.equal(activeContractPhase({ startedAt: 1, sandboxAt: 2 }, true), "sandbox");
  assert.equal(activeContractPhase({ startedAt: 1, sandboxAt: 2, evaluatorAt: 3 }, true), "evaluator");
  assert.equal(activeContractPhase({ startedAt: 1, sandboxAt: 2 }, false), null);
});

test("a finished check maps its items and averages the sample scores", () => {
  const progress = contractValidation({
    result: result(false, [item("workspace.run", "passed"), item("metric.shape", "failed", 1)]),
    checking: false,
    error: null,
    timing: { startedAt: 100, requestAt: 150, finishedAt: 900 },
    message: line,
  });
  assert.equal(progress?.status, "failed");
  assert.equal(progress?.finishedAt, 900);
  assert.deepEqual(progress?.response?.checks, [
    { key: "workspace.run", status: "succeeded", message: "line:workspace.run" },
    { key: "metric.shape", status: "failed", message: "line:metric.shape" },
  ]);
  assert.equal(progress?.response?.scorer_result?.score, 0.75);

  const passed = contractValidation({
    result: result(true, [item("workspace.run", "passed")]),
    checking: false,
    error: null,
    timing: null,
    message: line,
  });
  assert.equal(passed?.status, "succeeded");
});

test("a request that could not run fails on its message, at the step it reached", () => {
  const progress = contractValidation({
    result: null,
    checking: false,
    error: "network down",
    timing: { startedAt: 100, finishedAt: 120 },
    message: line,
  });
  assert.equal(progress?.status, "failed");
  assert.equal(progress?.message, "network down");
  assert.deepEqual(
    progress?.phases.map((p) => p.key),
    ["budget"],
  );
  assert.equal(progress?.response, undefined);
});
