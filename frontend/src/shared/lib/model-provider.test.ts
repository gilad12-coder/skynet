/** Contract: model ids resolve to the right brand slug and human name, and the no-pick fallback prefers the requested flag. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { catalogFallbackModel, modelDisplayName, modelProviderSlug } from "./model-provider.ts";

test("openrouter ids resolve to each featured lab's brand slug", () => {
  const cases: Record<string, string> = {
    anthropic: "anthropic",
    deepseek: "deepseek",
    google: "google",
    "meta-llama": "meta",
    meta: "meta",
    moonshotai: "moonshotai",
    openai: "openai",
    qwen: "qwen",
    "x-ai": "xai",
    xiaomi: "xiaomi",
    "z-ai": "zai",
  };
  for (const [vendor, slug] of Object.entries(cases)) {
    assert.equal(modelProviderSlug(`openrouter/${vendor}/some-model`), slug, vendor);
  }
});

test("a direct provider id keeps its first segment", () => {
  assert.equal(modelProviderSlug("openai/gpt-4o-mini"), "openai");
  assert.equal(modelProviderSlug("openrouter/auto"), "openrouter");
});

test("display name prefers the catalog name, else the id's last segment", () => {
  const catalog = [
    { value: "openrouter/anthropic/claude-haiku-5.5", display_name: "Claude Haiku 5.5" },
    { value: "openai/gpt-4o-mini", display_name: null },
    { value: "openrouter/x/blank", display_name: "  " },
  ];
  assert.equal(
    modelDisplayName("openrouter/anthropic/claude-haiku-5.5", catalog),
    "Claude Haiku 5.5",
  );
  assert.equal(modelDisplayName("openai/gpt-4o-mini", catalog), "gpt-4o-mini");
  assert.equal(modelDisplayName("openrouter/x/blank", catalog), "blank");
  assert.equal(modelDisplayName("openrouter/anthropic/claude-haiku-5.5"), "claude-haiku-5.5");
  assert.equal(modelDisplayName(null, catalog), "");
});

test("fallback model prefers the requested flag, then is_default", () => {
  const a = { value: "a", is_default: true };
  const b = { value: "b", is_interview_default: true };
  assert.equal(catalogFallbackModel([a, b], "is_interview_default"), b);
  assert.equal(catalogFallbackModel([a, b]), a);
  assert.equal(catalogFallbackModel([a], "is_interview_default"), a);
  assert.equal(catalogFallbackModel([{ value: "c" }], "is_interview_default"), null);
});
