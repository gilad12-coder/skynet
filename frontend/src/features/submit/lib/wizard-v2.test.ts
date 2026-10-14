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

const {
  WIZARD_V2_STEPS,
  contractSnapshot,
  initialWizardV2State,
  optimizerModelsReady,
  presetEngine,
  presetModels,
  taskInterviewPatch,
  taskIssue,
  wizardSteps,
  withContractBudget,
  withLevel,
} = await import("./wizard-v2.ts");
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

test("changing the spending limit makes the check stale", () => {
  const base = checkedState();
  const capped = { ...base, optimizer: { ...base.optimizer, maxCostCents: 493 } };
  const snapshot = contractSnapshot(capped);

  const lowered = { ...capped, optimizer: { ...capped.optimizer, maxCostCents: 100 } };
  const uncapped = { ...capped, optimizer: { ...capped.optimizer, budgetUncapped: true } };
  assert.notEqual(contractSnapshot(lowered), snapshot);
  assert.notEqual(contractSnapshot(uncapped), snapshot);
});

test("the sandboxed check's spec carries the execution budget id and revision", () => {
  const spec = { payload_kind: "unified_v1" } as unknown as UnifiedRunRequest;
  const sent = withContractBudget(spec, { id: "budget-1", revision: 7 });
  assert.equal(sent.execution_budget_id, "budget-1");
  assert.equal(sent.execution_budget_revision, 7);
  assert.equal(spec.execution_budget_id, undefined);
});

test("a new wizard starts at Guided on Auto, with the Settings scorer runs or 200", () => {
  const state = initialWizardV2State();
  assert.equal(state.level, "guided");
  assert.equal(state.optimizer.choice, "auto");
  assert.equal(state.optimizer.budget.max_scorer_runs, 200);
  assert.equal(initialWizardV2State("expert").level, "expert");
  assert.equal(initialWizardV2State("standard", 50).optimizer.budget.max_scorer_runs, 50);
});

const noDefaults = { taskModel: null, reflectionModel: null };

test("without Settings defaults the catalog default presets both models", () => {
  const preset = presetModels(initialWizardV2State().optimizer, noDefaults, "openai/gpt-default");
  assert.deepEqual(preset, {
    taskModel: { name: "openai/gpt-default", token_source: "managed" },
    reflectionModel: { name: "openai/gpt-default", token_source: "managed" },
  });
});

test("the Settings default models win over the catalog default, role by role", () => {
  const mine = { name: "anthropic/claude-x", token_source: "managed" as const };
  const preset = presetModels(
    initialWizardV2State().optimizer,
    { taskModel: mine, reflectionModel: { name: "" } },
    "openai/gpt-default",
  );
  assert.deepEqual(preset, {
    taskModel: mine,
    reflectionModel: { name: "openai/gpt-default", token_source: "managed" },
  });
  assert.deepEqual(
    presetModels(initialWizardV2State().optimizer, { taskModel: mine, reflectionModel: mine }, null),
    { taskModel: mine, reflectionModel: mine },
  );
});

test("an Automatic model resolves to whatever the catalog default is when the wizard opens", () => {
  const fresh = initialWizardV2State().optimizer;
  const automatic = { taskModel: null, reflectionModel: { name: "" } };
  assert.deepEqual(presetModels(fresh, automatic, "openai/gpt-old")?.taskModel, {
    name: "openai/gpt-old",
    token_source: "managed",
  });
  const later = presetModels(fresh, automatic, "anthropic/claude-new");
  assert.equal(later?.taskModel?.name, "anthropic/claude-new");
  assert.equal(later?.reflectionModel?.name, "anthropic/claude-new");
});

test("reflection Automatic runs the strongest model while the task model stays on best value", () => {
  const fresh = initialWizardV2State().optimizer;
  const preset = presetModels(fresh, noDefaults, "openai/gpt-value", "anthropic/claude-strong");
  assert.equal(preset?.taskModel?.name, "openai/gpt-value");
  assert.equal(preset?.reflectionModel?.name, "anthropic/claude-strong");
  assert.equal(
    presetModels(fresh, noDefaults, "openai/gpt-value", null)?.reflectionModel?.name,
    "openai/gpt-value",
  );
});

test("the preset never overwrites a model someone already set, and needs some default", () => {
  const empty = initialWizardV2State().optimizer;
  const picked = { name: "anthropic/claude-x", token_source: "managed" as const };
  const prefs = { taskModel: picked, reflectionModel: picked };
  assert.equal(presetModels({ ...empty, reflectionModel: picked }, prefs, "openai/gpt-default"), null);
  assert.equal(presetModels({ ...empty, taskModel: picked }, noDefaults, "openai/gpt-default"), null);
  assert.equal(presetModels(empty, noDefaults, null), null);
  assert.equal(presetModels(empty, noDefaults, undefined), null);
});

test("the Settings default engine applies only from Auto and only when it fits the task", () => {
  assert.equal(presetEngine("auto", "gepa", "prompt", "pairs"), "gepa");
  assert.equal(presetEngine("auto", "dspy_gepa", "prompt", "pairs"), null);
  assert.equal(presetEngine("best_of_n", "gepa", "prompt", "pairs"), null);
  assert.equal(presetEngine("auto", "auto", "prompt", "pairs"), null);
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

const withoutOptimizer = WIZARD_V2_STEPS.filter((step) => step !== "optimizer");

test("Guided skips the Optimizer step; Standard and Expert walk it", () => {
  assert.deepEqual(wizardSteps(readyState("guided"), false), withoutOptimizer);
  assert.deepEqual(wizardSteps(readyState("standard"), false), WIZARD_V2_STEPS);
  assert.deepEqual(wizardSteps(readyState("expert"), false), WIZARD_V2_STEPS);
});

test("Guided shows the Optimizer step when its defaults can't run or the user is on it", () => {
  assert.deepEqual(wizardSteps(readyState("guided"), true), WIZARD_V2_STEPS);
  assert.deepEqual(wizardSteps({ ...readyState("guided"), step: "optimizer" }, false), WIZARD_V2_STEPS);
});

test("Inputs is one screen, before and after data arrives", () => {
  const empty = initialWizardV2State("standard");
  assert.deepEqual(stepPages("inputs", empty), ["source"]);
  assert.deepEqual(stepPages("inputs", readyState("expert")), ["source"]);
});

test("Optimizer screens: Standard sees one plan screen, Expert and a blocked Guided the three", () => {
  assert.deepEqual(stepPages("optimizer", readyState("standard")), ["plan"]);
  assert.deepEqual(stepPages("optimizer", readyState("expert")), ["optimizer", "models", "budget"]);
  assert.deepEqual(stepPages("optimizer", readyState("guided", false)), [
    "optimizer",
    "models",
    "budget",
  ]);
});

test("switching to Guided on the Optimizer step moves on to the next step", () => {
  const onOptimizer = { ...readyState("standard"), step: "optimizer" as const };
  const guided = withLevel(onOptimizer, "guided", false);
  assert.equal(guided.level, "guided");
  assert.equal(guided.step, "metric");
  assert.equal(guided.furthestStep, "metric");
  assert.equal(withLevel(onOptimizer, "guided", true).step, "optimizer");
  assert.equal(withLevel(onOptimizer, "expert", false).step, "optimizer");
  assert.equal(withLevel(onOptimizer, "standard", false), onOptimizer);
});

test("switching level keeps every answer and re-lays out the current step", () => {
  const onOptimizer = {
    ...readyState("standard"),
    step: "optimizer" as const,
    optimizer: { ...readyState("standard").optimizer, choice: "gepa" as const },
  };
  const expert = withLevel(onOptimizer, "expert", false);
  assert.equal(expert.step, "optimizer");
  assert.deepEqual({ ...expert, level: "standard" }, onOptimizer);
  assert.deepEqual(stepPages("optimizer", onOptimizer), ["plan"]);
  assert.deepEqual(stepPages("optimizer", expert), ["optimizer", "models", "budget"]);

  const onMetric = { ...readyState("guided"), step: "metric" as const };
  const standard = withLevel(onMetric, "standard", false);
  assert.equal(standard.step, "metric");
  assert.deepEqual(wizardSteps(onMetric, false), withoutOptimizer);
  assert.deepEqual(wizardSteps(standard, false), WIZARD_V2_STEPS);
  assert.deepEqual({ ...standard, level: "guided" }, onMetric);
});

test("a DSPy program without a task model counts as missing models", () => {
  const state = readyState("guided");
  const dspy = {
    ...state,
    task: { ...state.task, artifactKind: "dspy_program" as const },
    optimizer: { ...state.optimizer, taskModel: null },
  };
  assert.equal(optimizerModelsReady(dspy), false);
  assert.equal(optimizerModelsReady(readyState("guided")), true);
});

test("before the task and inputs exist the Optimizer step has one placeholder screen", () => {
  assert.deepEqual(stepPages("optimizer", initialWizardV2State("expert")), ["optimizer"]);
});

test("the task step clears once nothing is missing, with no separate confirm", () => {
  const empty = initialWizardV2State().task;
  assert.equal("confirmed" in empty, false);
  assert.equal(taskIssue(empty), "submit.v2.task.issue.objective");
  const withObjective = { ...empty, objective: "Summarize tickets" };
  assert.equal(taskIssue(withObjective), "submit.v2.task.issue.kind");
  const withKind = { ...withObjective, artifactKind: "prompt" as const };
  assert.equal(taskIssue(withKind), "submit.v2.task.issue.starting");
  assert.equal(taskIssue({ ...withKind, startingVersion: "   " }), "submit.v2.task.issue.starting");
  assert.equal(
    taskIssue({ ...withKind, startingVersion: { a: " ", b: "" } }),
    "submit.v2.task.issue.starting",
  );
  assert.equal(taskIssue({ ...withKind, startingVersion: "Summarize:" }), null);
  assert.equal(taskIssue({ ...withKind, startingVersion: { a: "", b: "Do it." } }), null);
});

test("taskInterviewPatch keeps a rationale only from a turn that names the artifact kind", () => {
  const turn = {
    message: "",
    options: [],
    done: false,
    objective: "Route tickets",
    background: "",
    artifact_rationale: "The artifact kind is not yet known, so no rationale can be given.",
  };
  const early = taskInterviewPatch(turn, new Set());
  assert.equal(early.objective, "Route tickets");
  assert.equal("artifactRationale" in early, false);

  const named = taskInterviewPatch(
    { ...turn, artifact_kind: "prompt", artifact_rationale: "You already have a prompt to tune." },
    new Set(),
  );
  assert.equal(named.artifactKind, "prompt");
  assert.equal(named.artifactRationale, "You already have a prompt to tune.");

  const handPicked = taskInterviewPatch(
    { ...turn, artifact_kind: "prompt", artifact_rationale: "You already have a prompt to tune." },
    new Set(["objective", "artifactKind"]),
  );
  assert.deepEqual(handPicked, {});
});
