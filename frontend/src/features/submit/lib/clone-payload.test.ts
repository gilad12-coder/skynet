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
    cases: [{ brief: "launch", expected: "Hi" }, { brief: "renewal" }],
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

// Sanitized stored payload of staging run 52923146 (legacy ShinkaEvolve repository run).
const SHINKA_SETTINGS = {
  num_islands: 2,
  migration_interval: 10,
  migration_rate: 0,
  parent_selection: "weighted",
  parent_selection_lambda: 10,
  exploitation_alpha: 1,
  exploitation_ratio: 0.2,
  num_beams: 5,
  patch_diff: 0.6,
  patch_full: 0.3,
  patch_cross: 0.1,
  max_patch_attempts: 1,
  max_patch_resamples: 3,
  archive_size: 40,
  num_archive_inspirations: 1,
  num_top_k_inspirations: 1,
  elite_selection_ratio: 0.3,
  use_text_feedback: true,
  novelty: false,
  code_embed_sim_threshold: 0.99,
  max_novelty_attempts: 3,
  meta_notes: true,
  meta_rec_interval: 10,
  meta_max_recommendations: 5,
  max_parallel_evaluations: 2,
  max_parallel_proposals: 2,
  editor: "single_call",
};
const LEGACY_SHINKA_RUN = {
  name: "repo-speedup",
  is_private: true,
  objective: "Make the benchmark faster",
  recipe: "repo",
  scorer: {
    kind: "python",
    metric_code: "def score(c, o): ...",
    timeout_seconds: 300,
  },
  budget: { max_iterations: 4, max_scorer_runs: 8 },
  strategy: { mode: "single", engine: "shinka_evolve" },
  target: { kind: "repo", repo: { repository: "owner/repo", commit: "abc123" } },
  proposer: { harness: "codex", ralph: true, max_tool_calls: 100 },
  reflection_model_config: { name: "openrouter/refl" },
  extra_reflection_model_configs: [],
  shinka: SHINKA_SETTINGS,
  max_cost_cents: 448,
};

test("cloning the legacy ShinkaEvolve run restores its engine, limits and scorer settings", () => {
  const slices = cloneToSlices("blackbox", LEGACY_SHINKA_RUN, "repo-speedup");
  assert.equal(slices.optimizer.choice, "shinka_evolve");
  assert.deepEqual(slices.optimizer.budget, { max_iterations: 4, max_scorer_runs: 8 });
  assert.deepEqual(slices.optimizer.shinka, SHINKA_SETTINGS);
  assert.deepEqual(slices.optimizer.proposer, {
    harness: "codex",
    ralph: true,
    max_tool_calls: 100,
  });
  assert.equal(slices.workspace.metricTimeoutSeconds, 300);
  assert.equal(slices.optimizer.maxCostCents, 448);
  assert.equal(slices.optimizer.reflectionModel?.name, "openrouter/refl");
  assert.deepEqual(slices.optimizer.extraReflectionModels, []);
  assert.equal(slices.task.objective, "Make the benchmark faster");
  assert.equal(slices.workspace.metricCode, "def score(c, o): ...");
  assert.equal(slices.meta.name, "repo-speedup");
  assert.equal(slices.meta.isPrivate, true);
});

test("a legacy run's extra optimization models clone by alias or field name", () => {
  const byAlias = cloneToSlices("blackbox", {
    extra_reflection_model_configs: [{ name: "a" }, { bad: true }],
  });
  assert.deepEqual(
    byAlias.optimizer.extraReflectionModels?.map((m) => m.name),
    ["a"],
  );
  const byField = cloneToSlices("blackbox", {
    extra_reflection_model_settings: [{ name: "b" }],
  });
  assert.deepEqual(
    byField.optimizer.extraReflectionModels?.map((m) => m.name),
    ["b"],
  );
});

test("a legacy run in Auto mode keeps the default engine", () => {
  const auto = cloneToSlices("blackbox", { strategy: { mode: "auto" } });
  assert.equal(auto.optimizer.choice, undefined);
  const unknown = cloneToSlices("blackbox", {
    strategy: { mode: "single", engine: "retired_engine" },
  });
  assert.equal(unknown.optimizer.choice, undefined);
});

test("the spending cap clones for every payload shape", () => {
  assert.equal(
    cloneToSlices("blackbox", { payload_kind: "unified_v1", max_cost_cents: 120 }).optimizer
      .maxCostCents,
    120,
  );
  assert.equal(cloneToSlices("run", { max_cost_credits: 75 }).optimizer.maxCostCents, 75);
  assert.equal(cloneToSlices("blackbox", {}).optimizer.maxCostCents, undefined);
  assert.equal(cloneToSlices("blackbox", { max_cost_cents: 0 }).optimizer.maxCostCents, undefined);
});
