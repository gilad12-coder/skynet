import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

import type { UnifiedRunRequest } from "@/shared/types/unified-run";

const unifiedRunUrl = new URL("../../../shared/types/unified-run.ts", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/shared/types/unified-run") {
      return { shortCircuit: true, url: unifiedRunUrl };
    }
    return nextResolve(specifier, context);
  },
});

const { contractSnapshot, initialWizardV2State, withContractBudget } = await import("./wizard-v2.ts");

function checkedState() {
  const state = initialWizardV2State();
  return {
    ...state,
    task: { ...state.task, artifactKind: "prompt" as const, startingVersion: "Answer." },
    inputs: {
      ...state.inputs,
      mode: "labeled" as const,
      cases: [{ input: { q: "a" }, expected: { answer: "b" } }],
      inputFields: ["q"],
      expectedField: "answer",
    },
    workspace: { ...state.workspace, runCode: "def run(a, i): ...", metricCode: "def score(i, o): ..." },
  };
}

test("changing the cases, data source, split, task model or metric timeout makes the check stale", () => {
  const base = checkedState();
  const snapshot = contractSnapshot(base);
  assert.equal(contractSnapshot(checkedState()), snapshot);

  const edits = [
    { ...base, inputs: { ...base.inputs, cases: [{ input: { q: "z" }, expected: { answer: "b" } }] } },
    { ...base, inputs: { ...base.inputs, cases: [], stagedDatasetId: "ds-1" } },
    { ...base, inputs: { ...base.inputs, split: { train: 0.5, val: 0.25, test: 0.25 } } },
    { ...base, inputs: { ...base.inputs, shuffle: !base.inputs.shuffle } },
    { ...base, optimizer: { ...base.optimizer, taskModel: { name: "openai/gpt-x" } } },
    { ...base, workspace: { ...base.workspace, metricTimeoutSeconds: 5 } },
  ];
  for (const edited of edits) assert.notEqual(contractSnapshot(edited as typeof base), snapshot);

  const stagedA = { ...base, inputs: { ...base.inputs, cases: [], stagedDatasetId: "ds-1" } };
  const stagedB = { ...base, inputs: { ...base.inputs, cases: [], stagedDatasetId: "ds-2" } };
  assert.notEqual(contractSnapshot(stagedA), contractSnapshot(stagedB));
});

test("the sandboxed check's spec carries the execution budget id and revision", () => {
  const spec = { payload_kind: "unified_v1" } as unknown as UnifiedRunRequest;
  const sent = withContractBudget(spec, { id: "budget-1", revision: 7 });
  assert.equal(sent.execution_budget_id, "budget-1");
  assert.equal(sent.execution_budget_revision, 7);
  assert.equal(spec.execution_budget_id, undefined);
});
