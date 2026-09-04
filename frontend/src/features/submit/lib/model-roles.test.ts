import assert from "node:assert/strict";
import { test } from "node:test";

import {
  modelIdentity,
  optimizationModelFamily,
  proposerModelConfig,
  resolveScoringModel,
  sameModelConfig,
} from "./model-roles.ts";

const gpt = {
  name: "openai/gpt-4o",
  token_source: "managed" as const,
  temperature: 0.7,
  max_tokens: 1024,
};

test("modelIdentity ignores credentials and transport but keeps sampling settings", () => {
  assert.equal(
    modelIdentity({ ...gpt, base_url: "https://x", extra: { api_key: "sk-1", api_base: "u" } }),
    modelIdentity(gpt),
  );
  assert.notEqual(modelIdentity({ ...gpt, temperature: 0.1 }), modelIdentity(gpt));
  assert.notEqual(
    modelIdentity({ ...gpt, token_source: "byok", byok_provider: "p" }),
    modelIdentity(gpt),
  );
  assert.equal(modelIdentity({ name: "  " }), null);
  assert.equal(modelIdentity(null), null);
});

test("native model configuration drops unsupported sampling without changing token source", () => {
  assert.deepEqual(proposerModelConfig(gpt, true), {
    name: gpt.name,
    token_source: "managed",
    byok_provider: null,
  });
  assert.deepEqual(
    proposerModelConfig(
      {
        ...gpt,
        token_source: "byok",
        byok_provider: "openai",
        extra: { reasoning_effort: "high" },
      },
      true,
    ),
    { name: gpt.name, token_source: "byok", byok_provider: "openai" },
  );
  assert.equal(proposerModelConfig(gpt, false), gpt);
});

test("sameModelConfig compares full configs, not names", () => {
  assert.equal(sameModelConfig(gpt, { ...gpt }), true);
  assert.equal(sameModelConfig(gpt, { ...gpt, max_tokens: 2048 }), false);
  assert.equal(sameModelConfig({ name: "" }, null), true);
});

test("resolveScoringModel follows the optimization model while inherited", () => {
  const explicit = { name: "" };
  assert.equal(
    resolveScoringModel({ usesModel: false, mode: "inherit", explicit, optimization: gpt }),
    null,
  );
  assert.deepEqual(
    resolveScoringModel({ usesModel: true, mode: "inherit", explicit, optimization: { name: "" } }),
    {
      mode: "inherit",
      resolved: null,
      pending: true,
    },
  );
  assert.deepEqual(
    resolveScoringModel({ usesModel: true, mode: "inherit", explicit, optimization: gpt }),
    {
      mode: "inherit",
      resolved: gpt,
      pending: false,
    },
  );
});

test("resolveScoringModel keeps an explicit override even when it matches the optimization model", () => {
  const own = { ...gpt };
  const binding = resolveScoringModel({
    usesModel: true,
    mode: "explicit",
    explicit: own,
    optimization: gpt,
  });
  assert.equal(binding?.mode, "explicit");
  assert.equal(binding?.resolved, own);
  assert.equal(binding?.pending, false);
  assert.deepEqual(
    resolveScoringModel({
      usesModel: true,
      mode: "explicit",
      explicit: { name: "" },
      optimization: gpt,
    }),
    {
      mode: "explicit",
      resolved: null,
      pending: false,
    },
  );
});

test("optimizationModelFamily names the proposer the model drives", () => {
  assert.equal(optimizationModelFamily("auto", null), "auto");
  assert.equal(optimizationModelFamily("plateau", "meta_harness"), "auto");
  assert.equal(optimizationModelFamily("single", "best_of_n"), "gepa");
  assert.equal(optimizationModelFamily("single", "meta_harness"), "meta_harness");
  assert.equal(optimizationModelFamily("single", "autoresearch"), "autoresearch");
});
