/*
 * node --test cannot load .tsx, so run it from frontend/ through jiti:
 * JITI_JSX=1 JITI_ALIAS="{\"@/\":\"$PWD/src/\"}" npx jiti <this file>
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { setClientLocale } from "@/shared/lib/runtime-locale";
import type { BlackboxRunResult } from "@/shared/types/api";

// The classic JSX transform the test loader applies reads a global React.
(globalThis as { React?: typeof React }).React = React;

const { HeldOutNotice, RewardComparison, savedMetricCode } = await import("./RewardComparison");

const METRIC = `REWARD_SPEC = {
    "weights": {"accuracy": 0.35, "speed": 0.35, "cost": 0.30},
    "accuracy": {"meaning": "Distance", "unit": "km", "reference": 1.0},
    "speed": {"reference": 2000}, "cost": {"reference": 0.002},
}
`;

const observation = (ms: number, usd: number | null) => ({
  timing: { task_ms: ms },
  cost: usd == null ? { usd: null, status: "unavailable", reason: "no price" } : { usd },
});

/** A geocoding run: the winner is more accurate and faster, but more expensive. */
function result(): BlackboxRunResult {
  const named = (accuracy: number, speed: number, cost: number) => ({
    accuracy: { score: accuracy, feedback: "" },
    speed: { score: speed, feedback: "" },
    cost: { score: cost, feedback: "" },
  });
  return {
    baseline_score: 0.35 * 0.4 + 0.35 * 0.5 + 0.3 * 0.6,
    best_score: 0.35 * 0.8 + 0.35 * 0.6 + 0.3 * 0.5,
    baseline_named_scores: named(0.4, 0.5, 0.6),
    best_named_scores: named(0.8, 0.6, 0.5),
    case_results: [
      {
        index: 0,
        baseline_observation: observation(2000, 0.001),
        best_observation: observation(1000, 0.002),
      },
      {
        index: 1,
        baseline_observation: observation(2200, 0.001),
        best_observation: observation(1500, null),
      },
    ],
    split_counts: {
      train: 2,
      val: 1,
      test: 0,
      held_out: false,
      selection_split: "val",
      report_split: "val",
    },
  } as unknown as BlackboxRunResult;
}

function render(node: React.ReactElement): string {
  setClientLocale("en");
  return renderToStaticMarkup(node);
}

const row = (html: string, key: string) =>
  new RegExp(`<tr[^>]*data-row="${key}"[^>]*>[\\s\\S]*?</tr>`).exec(html)?.[0] ?? "";

void describe("RewardComparison", () => {
  void it("compares accuracy, mean and p95 time, cost, contributions and total", () => {
    const html = render(<RewardComparison result={result()} metricCode={METRIC} />);
    for (const key of [
      "accuracy",
      "mean_ms",
      "p95_ms",
      "cost",
      "contribution_accuracy",
      "contribution_speed",
      "contribution_cost",
      "total",
    ]) {
      assert.ok(row(html, key), key);
    }
    // Mean and p95 time come from each response's own observation.
    assert.match(row(html, "mean_ms"), /2,100 ms[\s\S]*1,250 ms/);
    assert.match(row(html, "p95_ms"), /2,200[\s\S]*1,500/);
    // Only the priced response counts toward the mean cost; the other is named.
    assert.match(row(html, "cost"), /\$0\.001[\s\S]*\$0\.002/);
    assert.match(html, /optimization\.reward\.unpriced/);
  });

  void it("marks a part that got worse even when the total rose", () => {
    const html = render(<RewardComparison result={result()} metricCode={METRIC} />);
    assert.doesNotMatch(row(html, "total"), /data-loss/);
    assert.match(row(html, "cost"), /data-loss="true"/);
    assert.match(row(html, "contribution_cost"), /data-loss="true"/);
    assert.doesNotMatch(row(html, "mean_ms"), /data-loss/);
    assert.match(html, /optimization\.reward\.losses/);
  });

  void it("renders nothing for a metric without a reward spec", () => {
    assert.equal(
      render(<RewardComparison result={result()} metricCode="def score(e, o): return 1" />),
      "",
    );
  });

  void it("reads the metric code a unified or legacy run saved", () => {
    assert.equal(savedMetricCode({ workspace: { metric_code: "a" } }), "a");
    assert.equal(savedMetricCode({ scorer: { metric_code: "b" } }), "b");
    assert.equal(savedMetricCode(undefined), null);
  });
});

void describe("HeldOutNotice", () => {
  void it("shows only when a unified split held nothing out", () => {
    assert.match(render(<HeldOutNotice splitCounts={result().split_counts} />), /not_held_out/);
    const heldOut = { ...result().split_counts, held_out: true };
    assert.equal(render(<HeldOutNotice splitCounts={heldOut} />), "");
    // A legacy DSPy split has no held_out flag.
    assert.equal(render(<HeldOutNotice splitCounts={{ train: 5, val: 2, test: 3 }} />), "");
  });
});
