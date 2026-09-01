import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalModelId, mergeModelUsage } from "./model-usage.ts";

test("only the gateway transport prefix is stripped", () => {
  assert.equal(
    canonicalModelId("litellm_proxy/google/gemini-3-flash-preview"),
    "google/gemini-3-flash-preview",
  );
  assert.equal(canonicalModelId("google/gemini-3-flash-preview"), "google/gemini-3-flash-preview");
  assert.equal(canonicalModelId("openrouter/anthropic/claude"), "openrouter/anthropic/claude");
});

test("one model under two spellings folds into one row", () => {
  const rows = mergeModelUsage([
    {
      model: "litellm_proxy/google/gemini-3-flash-preview",
      input_tokens: 62_235,
      output_tokens: 8_136,
    },
    { model: "google/gemini-3-flash-preview", input_tokens: 128_357, output_tokens: 5_260 },
  ]);
  assert.deepEqual(rows, [
    { model: "google/gemini-3-flash-preview", input_tokens: 190_592, output_tokens: 13_396 },
  ]);
});

test("distinct models keep their own rows in first-seen order", () => {
  const rows = mergeModelUsage([
    { model: "litellm_proxy/openai/gpt-5", input_tokens: 1, output_tokens: 2 },
    { model: "google/gemini-3-flash-preview", input_tokens: 3, output_tokens: 4 },
    { model: "openai/gpt-5", input_tokens: 5, output_tokens: 6 },
  ]);
  assert.deepEqual(rows, [
    { model: "openai/gpt-5", input_tokens: 6, output_tokens: 8 },
    { model: "google/gemini-3-flash-preview", input_tokens: 3, output_tokens: 4 },
  ]);
});
