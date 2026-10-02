import assert from "node:assert/strict";
import { test } from "node:test";
import {
  preflightIdentity,
  stableStringify,
  upgradeLegacyIdentity,
} from "./validation-evidence.ts";

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

test("a large dataset enters the identity as a short digest", () => {
  const dataset = Array.from({ length: 3000 }, (_, i) => ({ q: `question ${i} `.repeat(200) }));
  const identity = preflightIdentity("dspy", { dataset, max_cost_cents: 20 });
  assert.ok(identity.length < 200, `identity is ${identity.length} chars`);
  assert.equal(
    preflightIdentity("dspy", { dataset: dataset.slice() }),
    preflightIdentity("dspy", { dataset }),
  );
});

test("an identity saved in the old serialized form upgrades to today's", () => {
  const payload = {
    name: "dropped",
    zeta: [{ b: 1, a: [2, { d: null, c: "x" }] }],
    alpha: { y: undefined, x: true },
    skipped: undefined,
    dataset: [{ q: "first", a: "one" }],
    max_cost_cents: 20,
  };
  const { name: _name, ...setup } = payload;
  const legacy = stableStringify({ workflow: "anything", setup });
  assert.equal(upgradeLegacyIdentity(legacy), preflightIdentity("anything", payload));
  assert.notEqual(upgradeLegacyIdentity(legacy), preflightIdentity("dspy", payload));
  const current = preflightIdentity("dspy", payload);
  assert.equal(upgradeLegacyIdentity(current), current);
  assert.equal(upgradeLegacyIdentity('{"setup":broken'), '{"setup":broken');
});

test("a dataset swapped for new rows changes the identity even after it was cached", () => {
  const dataset = [{ q: "first" }];
  const original = preflightIdentity("dspy", { dataset });
  assert.equal(preflightIdentity("dspy", { dataset }), original);
  assert.notEqual(preflightIdentity("dspy", { dataset: [...dataset, { q: "second" }] }), original);
});
