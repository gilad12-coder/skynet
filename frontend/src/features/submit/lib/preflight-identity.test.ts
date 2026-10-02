import assert from "node:assert/strict";
import { test } from "node:test";
import { preflightIdentity, stableStringify } from "./validation-evidence.ts";

test("data, model settings and funding edits invalidate setup evidence while naming does not", () => {
  const payload = {
    execution_runtime: "vercel",
    model_config: { name: "model", temperature: 0.5 },
    dataset: [{ q: "first" }],
    max_cost_cents: 20,
  };
  const original = preflightIdentity("dspy", payload);
  assert.equal(
    preflightIdentity("dspy", {
      ...payload,
      name: "A new name",
      description: "Description",
      is_private: false,
    }),
    original,
  );
  assert.notEqual(
    preflightIdentity("dspy", { ...payload, model_config: { name: "model", temperature: 1 } }),
    original,
  );
  assert.notEqual(preflightIdentity("dspy", { ...payload, dataset: [{ q: "edited" }] }), original);
  assert.notEqual(preflightIdentity("dspy", { ...payload, max_cost_cents: 30 }), original);
});

test("MCP tool permission edits invalidate setup evidence", () => {
  const payload = {
    module_name: "react",
    tool_source: {
      kind: "live_mcp",
      mcp_url: "https://tools.example.test/mcp",
      tool_filter: ["lookup", "search"],
    },
  };
  const original = preflightIdentity("dspy", payload);
  assert.notEqual(
    preflightIdentity("dspy", {
      ...payload,
      tool_source: { ...payload.tool_source, tool_filter: ["lookup"] },
    }),
    original,
  );
});

test("the identity matches the plain stable serialization drafts already hold", () => {
  const payload = {
    name: "dropped",
    zeta: [{ b: 1, a: [2, { d: null, c: "x" }] }],
    alpha: { y: undefined, x: true },
    skipped: undefined,
    dataset: [{ q: "first", a: "one" }],
    max_cost_cents: 20,
  };
  const { name: _name, ...setup } = payload;
  assert.equal(
    preflightIdentity("anything", payload),
    stableStringify({ workflow: "anything", setup }),
  );
});

test("a dataset swapped for new rows changes the identity even after it was cached", () => {
  const dataset = [{ q: "first" }];
  const original = preflightIdentity("dspy", { dataset });
  assert.equal(preflightIdentity("dspy", { dataset }), original);
  assert.notEqual(preflightIdentity("dspy", { dataset: [...dataset, { q: "second" }] }), original);
});
