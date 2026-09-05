import assert from "node:assert/strict";
import test from "node:test";
import { scorerCallsModel, withScorerImports } from "./scorer-dependencies.ts";

test("detects direct, qualified and aliased model calls but ignores comments and strings", () => {
  for (const code of [
    'llm("judge")',
    'skynet.llm("judge")',
    'from skynet import llm as judge\njudge("x")',
  ])
    assert.equal(scorerCallsModel(code), true);
  assert.equal(scorerCallsModel('# llm("x")\ntext = "llm(x)"'), false);
});

test("makes legacy helpers explicit and keeps future imports first", () => {
  const code =
    '"""Scorer."""\nfrom __future__ import annotations\n\ndef score(c):\n    return llm(c), Image(c)\n';
  const updated = withScorerImports(code);
  assert.ok(
    updated.includes("from __future__ import annotations\n\nfrom skynet import llm, Image"),
  );
  assert.equal(withScorerImports(updated), updated);
});

test("preserves existing imports, qualified calls and locally defined helpers", () => {
  for (const code of [
    'from skynet import llm, Image\nllm("x")',
    'import skynet\nskynet.llm("x")',
    'def llm(x): return x\nllm("x")',
  ])
    assert.equal(withScorerImports(code), code);
});
