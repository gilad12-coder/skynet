import assert from "node:assert/strict";
import { test } from "node:test";

import { cloneToSlices } from "./clone-payload.ts";

test("a unified run clones every slice it stored", () => {
  const slices = cloneToSlices(
    "blackbox",
    {
      payload_kind: "unified_v1",
      name: "stored-name",
      is_private: true,
      task: {
        objective: "Summarize tickets",
        background: "Support queue",
        artifact: { kind: "prompt", starting_version: "Summarize:" },
      },
      data: {
        mode: "pairs",
        cases: [
          { input: { ticket: "a" }, expected: "x" },
          { input: { ticket: "b" }, expected: "y" },
        ],
        input_fields: ["ticket"],
        split: { train: 0.6, val: 0.2, test: 0.2 },
        shuffle: false,
      },
      optimizer: { choice: "gepa", budget: { max_scorer_runs: 50 } },
      models: {
        reflection_model: { name: "gpt-x" },
        metric_model: { name: "judge-y" },
      },
      workspace: { run_code: "def run(a, i): ...", metric_code: "def score(i, o): ..." },
    },
    "Job name",
  );
  assert.equal(slices.meta.name, "Job name");
  assert.equal(slices.meta.isPrivate, true);
  assert.equal(slices.task.artifactKind, "prompt");
  assert.equal(slices.task.startingVersion, "Summarize:");
  assert.equal(slices.task.confirmed, undefined);
  assert.equal(slices.inputs.mode, "pairs");
  assert.equal(slices.inputs.cases?.length, 2);
  assert.deepEqual(slices.inputs.inputFields, ["ticket"]);
  assert.deepEqual(slices.inputs.split, { train: 0.6, val: 0.2, test: 0.2 });
  assert.equal(slices.inputs.shuffle, false);
  assert.equal(slices.optimizer.choice, "gepa");
  assert.equal(slices.optimizer.reflectionModel?.name, "gpt-x");
  assert.equal(slices.workspace.metricModelMode, "explicit");
  assert.equal(slices.workspace.metricModel?.name, "judge-y");
  assert.equal(slices.workspace.runCode, "def run(a, i): ...");
});

test("a metric model equal to the reflection model clones as inherited", () => {
  const slices = cloneToSlices("blackbox", {
    payload_kind: "unified_v1",
    models: { reflection_model: { name: "same" }, metric_model: { name: "same" } },
  });
  assert.equal(slices.workspace.metricModelMode, "inherit");
  assert.equal(slices.workspace.metricModel, null);
});

test("a legacy black-box run maps objective, seed, cases and scorer", () => {
  const slices = cloneToSlices("blackbox", {
    objective: "Write emails",
    background: "B2B",
    seed_candidate: { system: "Be brief", user: "{brief}" },
    cases: [
      { brief: "launch", expected: "Hi" },
      { brief: "renewal" },
    ],
    scorer: { kind: "python", metric_code: "def score(c, o): ...", model: { name: "judge" } },
    reflection_model_config: { name: "refl" },
  });
  assert.equal(slices.task.objective, "Write emails");
  assert.deepEqual(slices.task.startingVersion, { system: "Be brief", user: "{brief}" });
  assert.equal(slices.inputs.mode, "pairs");
  assert.deepEqual(slices.inputs.cases?.[0], { input: { brief: "launch" }, expected: "Hi" });
  assert.deepEqual(slices.inputs.cases?.[1], { input: { brief: "renewal" }, expected: null });
  assert.equal(slices.workspace.metricCode, "def score(c, o): ...");
  assert.equal(slices.workspace.metricModelMode, "explicit");
  assert.equal(slices.optimizer.reflectionModel?.name, "refl");
});

test("a legacy DSPy run maps rows by the column mapping and keeps metric_code", () => {
  const slices = cloneToSlices("run", {
    dataset: [
      { email_text: "Win $1000", category: "spam", note: "x" },
      { email_text: "Standup", category: "ok", note: "y" },
    ],
    column_mapping: { inputs: { email_text: "str" }, outputs: { category: "str" } },
    metric_code: "def metric(gold, pred, trace=None): ...",
    model_config: { name: "task-m" },
  });
  assert.equal(slices.task.artifactKind, "dspy_program");
  assert.deepEqual(slices.inputs.cases?.[0], {
    input: { email_text: "Win $1000" },
    expected: { category: "spam" },
  });
  assert.deepEqual(slices.inputs.inputFields, ["email_text"]);
  assert.equal(slices.inputs.expectedField, "category");
  assert.equal(slices.workspace.metricCode, "def metric(gold, pred, trace=None): ...");
  assert.equal(slices.optimizer.taskModel?.name, "task-m");
});

test("an unmapped legacy DSPy run leaves the inputs empty", () => {
  const slices = cloneToSlices("grid_search", { dataset: [{ a: 1 }] });
  assert.deepEqual(slices.inputs, {});
});
