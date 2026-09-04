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
  auto_checkpoint_recovery_supported: false,
  auto_checkpoint_recovery_reason: "Auto recovery requires a new search.",
  upstream_revision: "pinned",
  run_recovery_eligibility:
    "Recovery also requires a compatible saved checkpoint and enough funded headroom.",
  proposer_runtimes: [
    {
      id: "vercel",
      available: true,
      unavailable_reason: null,
      cost: {
        billing_basis: "at_cost",
        minimum_session_credits: "1",
        maximum_session_credits: "12",
        maximum_lifetime_seconds: 3600,
        vcpus: 2,
      },
      checkpoint_restore_supported: true,
      checkpoint_restore_reason: null,
    },
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
      checkpoint_recovery_supported: id === "gepa",
      checkpoint_recovery_reason: id === "gepa" ? null : `${id} cannot restore checkpoints.`,
    }),
  ),
};

const selection = {
  catalog,
  mode: "auto" as const,
  engine: null,
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

test("native engines accept text evaluation in the managed sandbox without an agent target", () => {
  for (const engine of ["meta_harness", "autoresearch"] as const) {
    assert.equal(engineSelectionIssue({ ...selection, mode: "single", engine }), null);
    assert.equal(usesNativeProposer("single", engine), true);
  }
  assert.equal(usesNativeProposer("auto", null), true);
  assert.equal(usesNativeProposer("plateau", null), true);
  assert.equal(usesNativeProposer("single", "gepa"), false);
  assert.equal(usesNativeProposer("single", "best_of_n"), false);
});

test("managed sandbox availability gates native engines without disabling GEPA", () => {
  const unavailable: BlackboxEngineCatalogResponse = {
    ...catalog,
    proposer_runtimes: [
      {
        ...catalog.proposer_runtimes[0],
        available: false,
        unavailable_reason: "Managed sandbox is unavailable",
      },
    ],
  };
  assert.deepEqual(engineSelectionIssue({ ...selection, catalog: unavailable }), {
    key: "submit.blackbox.run_disabled.runtime_reason",
    params: { reason: "Managed sandbox is unavailable" },
  });
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
