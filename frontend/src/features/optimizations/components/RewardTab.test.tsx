/*
 * node --test cannot load .tsx, so this runs through jiti (reward-ui.render.test.ts
 * spawns it inside `npm run test:unit`). To run it by hand from frontend/:
 * JITI_JSX=1 JITI_ALIAS="{\"@/\":\"$PWD/src/\"}" npx jiti <this file>
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { bundledRewards } from "@/shared/lib/reward-rules";
import { buildToMetricCode } from "@/shared/lib/reward-rules-code";
import { setClientLocale } from "@/shared/lib/runtime-locale";
import { TooltipProvider } from "@/shared/ui/primitives/tooltip";
import type { BlackboxRunResult } from "@/shared/types/api";

// The classic JSX transform the test loader applies reads a global React.
(globalThis as { React?: typeof React }).React = React;
const { RewardTab, hasRewardTab, runSamples } = await import("./RewardTab");

const CODE_METRIC = `REWARD_SPEC = {
    "weights": {"accuracy": 0.5, "speed": 0.5, "cost": 0},
    "accuracy": {"meaning": "Distance", "unit": "km", "reference": 1.0},
    "speed": {"reference": 2000}, "cost": {"reference": 0.002},
}
`;

const UI_METRIC = buildToMetricCode({
  rewards: bundledRewards("answer").slice(0, 1),
  speed: { weight: 1, reference: 2000 },
  cost: { weight: 0, reference: 0.001 },
});

const payload = (metricCode: string) => ({
  workspace: { metric_code: metricCode },
  data: { expected_field: "answer", cases: [{ input: { q: "1+1" }, expected: { answer: "2" } }] },
});

function result(): BlackboxRunResult {
  const named = (accuracy: number, speed: number) => ({
    accuracy: { score: accuracy, feedback: "" },
    speed: { score: speed, feedback: "" },
    cost: { score: 1, feedback: "" },
  });
  return {
    baseline_score: 0.45,
    best_score: 0.7,
    baseline_named_scores: named(0.4, 0.5),
    best_named_scores: named(0.8, 0.6),
    case_results: [],
    split_counts: { train: 2, val: 1, test: 0 },
  } as unknown as BlackboxRunResult;
}

function render(node: React.ReactElement): string {
  setClientLocale("en");
  return renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);
}

void describe("RewardTab", () => {
  void it("shows only for a metric with a valid REWARD_SPEC", () => {
    assert.equal(hasRewardTab(payload(CODE_METRIC)), true);
    assert.equal(hasRewardTab(payload(UI_METRIC)), true);
    assert.equal(hasRewardTab(payload("def score(e, o):\n    return 1.0\n")), false);
    assert.equal(hasRewardTab(undefined), false);
  });

  void it("turns a code metric into its parts and compares the run", () => {
    const html = render(<RewardTab payload={payload(CODE_METRIC)} result={result()} />);
    assert.match(html, /submit\.v2\.reward\.formula/);
    assert.doesNotMatch(html, /reward_builder\.try\.title/);
    assert.match(html, /optimization\.reward\.title/);
    assert.match(html, /data-row="total"/);
  });

  void it("shows a UI reward's rows read-only with Try it", () => {
    const html = render(<RewardTab payload={payload(UI_METRIC)} result={null} />);
    assert.match(html, /exact-answer/);
    assert.match(html, /reward_builder\.try\.title/);
    assert.doesNotMatch(html, /reward_builder\.add</);
    // No result yet, so no comparison.
    assert.doesNotMatch(html, /optimization\.reward\.title/);
  });

  void it("reads the expected column and cases for Try it", () => {
    const { expectedField, samples } = runSamples(payload(UI_METRIC));
    assert.equal(expectedField, "answer");
    assert.deepEqual(samples, [{ input: { q: "1+1" }, expected: { answer: "2" } }]);
  });
});
