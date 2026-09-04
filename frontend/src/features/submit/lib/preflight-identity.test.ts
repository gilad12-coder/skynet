import assert from "node:assert/strict";
import { test } from "node:test";
import { preflightIdentity } from "./validation-evidence.ts";

test("data, model settings and funding edits invalidate setup evidence while naming does not", () => {
  const payload = {
    execution_runtime: "vercel",
    model_config: { name: "model", temperature: 0.5 },
    dataset: [{ q: "first" }],
    max_cost_credits: 20,
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
  assert.notEqual(preflightIdentity("dspy", { ...payload, max_cost_credits: 30 }), original);
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
