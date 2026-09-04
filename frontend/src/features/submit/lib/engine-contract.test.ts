import assert from "node:assert/strict";
import { test } from "node:test";

import type { BlackboxEngineCatalogResponse, BlackboxEngineId } from "@/shared/types/api";
import {
  engineSelectionIssue,
  supportsIterationLimit,
  usesNativeProposer,
} from "./engine-contract.ts";

const catalog: BlackboxEngineCatalogResponse = {
  target_kind: "text",
  sandbox_available: true,
  auto_engines: ["gepa", "autoresearch", "meta_harness"],
  auto_available: true,
  auto_unavailable_reason: null,
  upstream_revision: "pinned",
  proposer_runtimes: [
    { id: "worker", available: true, unavailable_reason: null },
    { id: "vercel", available: true, unavailable_reason: null },
  ],
  engines: (["gepa", "best_of_n", "autoresearch", "meta_harness"] as BlackboxEngineId[]).map(
    (id) => ({
      id,
      label: id,
      description: id,
      available: true,
      unavailable_reason: null,
      supports_parts: id === "gepa",
      requires_agent_target: false,
    }),
  ),
};

const selection = {
  catalog,
  mode: "auto" as const,
  engine: null,
  runtime: "worker" as const,
  hasParts: false,
  trainingCaseCount: null,
};

test("iteration limits apply only to a single Meta-Harness run", () => {
  assert.equal(supportsIterationLimit("single", "meta_harness"), true);
  for (const engine of ["gepa", "best_of_n", "autoresearch", null] as const) {
    assert.equal(supportsIterationLimit("single", engine), false);
  }
  for (const mode of ["auto", "plateau"] as const) {
    assert.equal(supportsIterationLimit(mode, "meta_harness"), false);
    assert.equal(supportsIterationLimit(mode, null), false);
  }
});

test("Auto and Plateau require the complete server recipe even when its lanes are listed", () => {
  for (const mode of ["auto", "plateau"] as const) {
    assert.equal(engineSelectionIssue({ ...selection, mode }), null);
    assert.deepEqual(
      engineSelectionIssue({
        ...selection,
        mode,
        catalog: { ...catalog, auto_available: false, auto_unavailable_reason: "Missing CLI" },
      }),
      {
        key: "submit.blackbox.run_disabled.auto_reason",
        params: { reason: "Missing CLI" },
      },
    );
    assert.equal(
      engineSelectionIssue({ ...selection, mode, hasParts: true })?.key,
      "submit.blackbox.validation.auto_parts",
    );
  }
});

test("missing or legacy capabilities cannot authorize an Auto run", () => {
  assert.equal(
    engineSelectionIssue({ ...selection, catalog: null })?.key,
    "submit.blackbox.engines.checking",
  );
  const { auto_available: _omitted, ...legacyCatalog } = catalog;
  assert.equal(
    engineSelectionIssue({
      ...selection,
      catalog: legacyCatalog as BlackboxEngineCatalogResponse,
    })?.key,
    "submit.blackbox.run_disabled.no_engines",
  );
});

test("native engines accept text evaluation and either runtime without an agent target", () => {
  for (const engine of ["meta_harness", "autoresearch"] as const) {
    for (const runtime of ["worker", "vercel"] as const) {
      assert.equal(engineSelectionIssue({ ...selection, mode: "single", engine, runtime }), null);
    }
    assert.equal(usesNativeProposer("single", engine), true);
  }
  assert.equal(usesNativeProposer("auto", null), true);
  assert.equal(usesNativeProposer("plateau", null), true);
  assert.equal(usesNativeProposer("single", "gepa"), false);
  assert.equal(usesNativeProposer("single", "best_of_n"), false);
});

test("runtime availability gates native engines without disabling GEPA", () => {
  const unavailable: BlackboxEngineCatalogResponse = {
    ...catalog,
    proposer_runtimes: [
      { id: "worker", available: false, unavailable_reason: "Worker is missing isolation" },
      { id: "vercel", available: true, unavailable_reason: null },
    ],
  };
  assert.deepEqual(engineSelectionIssue({ ...selection, catalog: unavailable }), {
    key: "submit.blackbox.run_disabled.runtime_reason",
    params: { reason: "Worker is missing isolation" },
  });
  assert.equal(
    engineSelectionIssue({ ...selection, catalog: unavailable, runtime: "vercel" }),
    null,
  );
  assert.equal(
    engineSelectionIssue({ ...selection, catalog: unavailable, mode: "single", engine: "gepa" }),
    null,
  );
});

test("parts follow each single engine's capabilities", () => {
  assert.equal(
    engineSelectionIssue({ ...selection, mode: "single", engine: "gepa", hasParts: true }),
    null,
  );
  assert.equal(
    engineSelectionIssue({ ...selection, mode: "single", engine: "best_of_n", hasParts: true })
      ?.key,
    "submit.blackbox.validation.engine_parts",
  );
});

test("Meta-Harness recipes require training cases without moving validation data", () => {
  for (const mode of ["auto", "plateau", "single"] as const) {
    assert.equal(
      engineSelectionIssue({ ...selection, mode, engine: "meta_harness", trainingCaseCount: 0 })
        ?.key,
      "submit.blackbox.validation.training_cases",
    );
    assert.equal(
      engineSelectionIssue({ ...selection, mode, engine: "meta_harness", trainingCaseCount: 1 }),
      null,
    );
    assert.equal(
      engineSelectionIssue({ ...selection, mode, engine: "meta_harness", trainingCaseCount: null }),
      null,
    );
  }
  for (const engine of ["gepa", "autoresearch"] as const) {
    assert.equal(
      engineSelectionIssue({ ...selection, mode: "single", engine, trainingCaseCount: 0 }),
      null,
    );
  }
});
