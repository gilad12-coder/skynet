import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

import type { CatalogModel } from "@/shared/types/api";

// The catalog module fetches through these at load; the ranking helpers don't need them.
const stubs: Record<string, string> = {
  "@/shared/lib/api": "export const getByokModels = async () => ({ providers: [], models: [] });",
  "@/shared/lib/runtime-env": "export const getRuntimeEnv = () => ({ apiUrl: '' });",
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const source = stubs[specifier];
    if (source !== undefined) {
      return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(source)}` };
    }
    return nextResolve(specifier, context);
  },
});

const { rankModels } = await import("./model-catalog.ts");

function model(value: string, fields: Partial<CatalogModel> = {}): CatalogModel {
  return {
    value,
    label: value,
    provider: "openrouter",
    supports_thinking: true,
    supports_vision: false,
    available: true,
    ...fields,
  };
}

const values = (models: CatalogModel[]) => models.map((m) => m.value);

test("best value lists the score-price frontier by score per dollar, then the beaten, then the unrated", () => {
  const groups = rankModels(
    [
      model("unrated"),
      model("pricey-genius", { intelligence_index: 70, input_cost_per_token: 10e-6 }),
      model("beaten", { intelligence_index: 40, input_cost_per_token: 2e-6 }),
      model("cheap-mid", { intelligence_index: 50, input_cost_per_token: 1e-6 }),
      model("unpriced", { intelligence_index: 60 }),
    ],
    "best_value",
  );
  assert.deepEqual(
    groups.map((g) => [g.kind, values(g.models)]),
    [
      ["ranked", ["cheap-mid", "pricey-genius"]],
      ["dominated", ["beaten", "unpriced"]],
      ["unrated", ["unrated"]],
    ],
  );
});

test("smartest sorts by intelligence index and puts the unrated last", () => {
  const groups = rankModels(
    [
      model("none"),
      model("mid", { intelligence_index: 50 }),
      model("top", { intelligence_index: 70 }),
    ],
    "smartest",
  );
  assert.deepEqual(
    groups.map((g) => [g.kind, values(g.models)]),
    [
      ["ranked", ["top", "mid"]],
      ["unrated", ["none"]],
    ],
  );
});

test("fastest sorts by time to a short reply and puts the unmeasured last", () => {
  const groups = rankModels(
    [
      model("unmeasured"),
      // 300ms + 150 tokens at 50 tok/s = 3300ms
      model("slow-stream", { throughput_tps: 50, latency_ms: 300 }),
      // 1000ms + 150 tokens at 300 tok/s = 1500ms
      model("slow-start", { throughput_tps: 300, latency_ms: 1000 }),
    ],
    "fastest",
  );
  assert.deepEqual(
    groups.map((g) => [g.kind, values(g.models)]),
    [
      ["ranked", ["slow-start", "slow-stream"]],
      ["no_speed", ["unmeasured"]],
    ],
  );
});

test("empty groups are dropped", () => {
  assert.deepEqual(
    rankModels([model("a")], "smartest").map((g) => g.kind),
    ["unrated"],
  );
  assert.deepEqual(rankModels([], "best_value"), []);
});
