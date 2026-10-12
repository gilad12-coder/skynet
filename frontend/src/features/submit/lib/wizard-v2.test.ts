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

const { contractSnapshot, enterStep, initialWizardV2State, presetModels, withContractBudget } =
  await import("./wizard-v2.ts");
const { stepPages } = await import("./wizard-pages.ts");

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
    workspace: {
      ...state.workspace,
      runCode: "def run(a, i): ...",
      metricCode: "def score(i, o): ...",
    },
  };
}

test("changing the cases, data source, split, task model or metric timeout makes the check stale", () => {
  const base = checkedState();
  const snapshot = contractSnapshot(base);
  assert.equal(contractSnapshot(checkedState()), snapshot);

  const edits = [
    {
      ...base,
      inputs: { ...base.inputs, cases: [{ input: { q: "z" }, expected: { answer: "b" } }] },
    },
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

test("a new wizard starts at Guided with the full Optimizer screens collapsed", () => {
  const state = initialWizardV2State();
  assert.equal(state.level, "guided");
  assert.equal(state.optimizer.expanded, false);
  assert.equal(state.optimizer.choice, "auto");
  assert.equal(state.optimizer.budget.max_scorer_runs, 200);
  assert.equal(initialWizardV2State("expert").level, "expert");
});

test("the catalog default presets the task and reflection models of a new wizard", () => {
  const preset = presetModels(initialWizardV2State().optimizer, "openai/gpt-default");
  assert.deepEqual(preset, {
    taskModel: { name: "openai/gpt-default", token_source: "managed" },
    reflectionModel: { name: "openai/gpt-default", token_source: "managed" },
  });
});

test("the preset never overwrites a model someone already set, and needs a catalog default", () => {
  const empty = initialWizardV2State().optimizer;
  const picked = { name: "anthropic/claude-x", token_source: "managed" as const };
  assert.equal(presetModels({ ...empty, reflectionModel: picked }, "openai/gpt-default"), null);
  assert.equal(presetModels({ ...empty, taskModel: picked }, "openai/gpt-default"), null);
  assert.equal(presetModels(empty, null), null);
  assert.equal(presetModels(empty, undefined), null);
});

function readyState(level: "guided" | "standard" | "expert", withModels = true) {
  const state = checkedState();
  const model = { name: "openai/gpt-default", token_source: "managed" as const };
  return {
    ...state,
    level,
    optimizer: {
      ...state.optimizer,
      taskModel: withModels ? model : null,
      reflectionModel: withModels ? model : null,
    },
  };
}

test("Optimizer screens: Guided and Standard see one summary, Expert the three full screens", () => {
  assert.deepEqual(stepPages("optimizer", readyState("guided")), ["summary"]);
  assert.deepEqual(stepPages("optimizer", readyState("standard")), ["summary"]);
  assert.deepEqual(stepPages("optimizer", readyState("expert")), ["optimizer", "models", "budget"]);
});

test("Standard's Change opens the full screens and ends on the summary", () => {
  const changed = readyState("standard");
  changed.optimizer = { ...changed.optimizer, expanded: true };
  assert.deepEqual(stepPages("optimizer", changed), ["optimizer", "models", "budget", "summary"]);
});

test("entering the Optimizer step without models opens the models screen at every level", () => {
  for (const level of ["guided", "standard", "expert"] as const) {
    const entered = enterStep(readyState(level, false), "optimizer", "optimizer");
    assert.equal(entered.step, "optimizer");
    assert.ok(stepPages("optimizer", entered).includes("models"), level);
  }
  const ready = enterStep(readyState("guided"), "optimizer", "optimizer");
  assert.equal(ready.optimizer.expanded, false);
  assert.deepEqual(stepPages("optimizer", ready), ["summary"]);
});

test("a DSPy program without a task model counts as missing models", () => {
  const state = readyState("guided");
  const dspy = {
    ...state,
    task: { ...state.task, artifactKind: "dspy_program" as const },
    optimizer: { ...state.optimizer, taskModel: null },
  };
  assert.equal(enterStep(dspy, "optimizer", "optimizer").optimizer.expanded, true);
});

test("before the task and inputs exist the Optimizer step has one placeholder screen", () => {
  assert.deepEqual(stepPages("optimizer", initialWizardV2State("expert")), ["optimizer"]);
});
