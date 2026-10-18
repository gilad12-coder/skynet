import assert from "node:assert/strict";
import { test } from "node:test";

import {
  readRewardSpec,
  rewardPreviewCases,
  scoreReward,
  summarizeObservations,
  type RewardSpec,
} from "./reward.ts";

const GEOCODING_METRIC = `
import math
from skynet import reward

# The agreed CFCA blend.
REWARD_SPEC = {
    "weights": {"accuracy": 0.35, "speed": 0.35, "cost": 0.30},
    "accuracy": {"meaning": "Distance to the labeled point", "unit": "km", "reference": 1.0},
    "speed": {"meaning": "Time to answer one message", "unit": "ms", "reference": 2000},
    "cost": {"meaning": "Service cost of one message", "unit": "USD", "reference": 0.002},
}

def score(example, output):
    return reward(REWARD_SPEC, None)
`;

function spec(): RewardSpec {
  const read = readRewardSpec(GEOCODING_METRIC);
  assert.equal(read.kind, "spec");
  return read.spec;
}

test("reads the metric's REWARD_SPEC with its units, meanings and normalized weights", () => {
  const s = spec();
  assert.deepEqual(s.weights, { accuracy: 0.35, speed: 0.35, cost: 0.3 });
  assert.equal(s.accuracy.unit, "km");
  assert.equal(s.accuracy.reference, 1);
  assert.equal(s.speed.reference, 2000);
  assert.equal(s.cost.meaning, "Service cost of one message");
});

test("normalizes weights that do not sum to 1, as the harness does", () => {
  const read = readRewardSpec(`REWARD_SPEC = {
    'weights': {'accuracy': 2, 'speed': 1, 'cost': 1},  # comment
    'speed': {'reference': 1_000}, 'cost': {'reference': 1e-3},
  }`);
  assert.equal(read.kind, "spec");
  assert.deepEqual(read.spec.weights, { accuracy: 0.5, speed: 0.25, cost: 0.25 });
  assert.equal(read.spec.accuracy.reference, null);
  assert.equal(read.spec.speed.reference, 1000);
});

test("no spec reads as none, and a spec the harness would refuse reads as invalid", () => {
  assert.equal(readRewardSpec("def score(e, o):\n    return 1.0").kind, "none");
  assert.equal(readRewardSpec(null).kind, "none");
  for (const bad of [
    "REWARD_SPEC = make_spec()",
    "REWARD_SPEC = {'weights': {'accuracy': 1, 'speed': 1, 'cost': 1}, 'speed': {'reference': 0}, 'cost': {'reference': 1}}",
    "REWARD_SPEC = {'weights': {'accuracy': 0, 'speed': 0, 'cost': 0}, 'speed': {'reference': 1}, 'cost': {'reference': 1}}",
    "REWARD_SPEC = {'weights': {'accuracy': 1, 'speed': 1}, 'speed': {'reference': 1}, 'cost': {'reference': 1}}",
  ]) {
    assert.equal(readRewardSpec(bad).kind, "invalid", bad);
  }
});

test("matches the harness formula: half at each reference, weighted sum", () => {
  const s = spec();
  const at = scoreReward(s, { accuracy: 1, timeMs: 2000, costUsd: 0.002 });
  assert.deepEqual(at.components, { accuracy: 0.5, speed: 0.5, cost: 0.5 });
  assert.ok(Math.abs(at.total - 0.5) < 1e-12);
  const best = scoreReward(s, { accuracy: 0, timeMs: 0, costUsd: 0 });
  assert.ok(Math.abs(best.total - 1) < 1e-12);
});

test("criterion 1: each one-change improvement raises the total, on both sides of the reference", () => {
  const s = spec();
  const pairs = rewardPreviewCases(s).filter((c) => c.change);
  for (const component of ["accuracy", "speed", "cost"] as const) {
    const own = pairs.filter((c) => c.change?.component === component);
    assert.equal(own.length, 2, component);
    const ref = component === "accuracy" ? 1 : component === "speed" ? 2000 : 0.002;
    assert.ok(own.some((c) => c.change!.from > ref && c.change!.to > ref), `${component} above`);
    assert.ok(own.some((c) => c.change!.from < ref && c.change!.to < ref), `${component} below`);
    for (const c of own) {
      assert.ok(scoreReward(s, c.inputs).total > scoreReward(s, c.before!).total, component);
    }
  }
});

test("criterion 1: a 0-1 accuracy score (no reference) also rises with every improvement", () => {
  const read = readRewardSpec(
    "REWARD_SPEC = {'weights': {'accuracy': 1, 'speed': 1, 'cost': 1}, 'speed': {'reference': 500}, 'cost': {'reference': 0.01}}",
  );
  assert.equal(read.kind, "spec");
  for (const c of rewardPreviewCases(read.spec).filter((p) => p.change)) {
    assert.ok(scoreReward(read.spec, c.inputs).total > scoreReward(read.spec, c.before!).total);
  }
});

test("criterion 2: the tradeoff case wins on total while it loses on speed and cost", () => {
  const s = spec();
  const cases = rewardPreviewCases(s);
  const reference = scoreReward(s, cases.find((c) => c.kind === "reference")!.inputs);
  const tradeoff = scoreReward(s, cases.find((c) => c.kind === "tradeoff")!.inputs);
  assert.ok(tradeoff.total > reference.total);
  assert.ok(tradeoff.components.speed < reference.components.speed);
  assert.ok(tradeoff.components.cost < reference.components.cost);
});

test("criterion 3: empty and wrong but fast, cheap answers score low; an unpriced call scores 0 cost", () => {
  const s = spec();
  const cases = rewardPreviewCases(s);
  const get = (kind: string) => scoreReward(s, cases.find((c) => c.kind === kind)!.inputs);
  const reference = get("reference");
  const empty = get("empty");
  assert.deepEqual(empty.unavailable, ["accuracy"]);
  assert.equal(empty.components.accuracy, 0);
  // No accuracy floor: speed and cost still count, so the score is not 0.
  assert.ok(empty.total > 0 && empty.total < 0.66);
  const wrong = get("wrong");
  assert.ok(wrong.components.accuracy < 0.05);
  const noCost = get("no_cost");
  assert.deepEqual(noCost.unavailable, ["cost"]);
  assert.equal(noCost.components.cost, 0);
  assert.ok(noCost.total < reference.total);
});

test("criterion 4: a response's score depends only on its own values and the fixed spec", () => {
  const s = spec();
  const one = { accuracy: 0.4, timeMs: 1200, costUsd: 0.001 };
  const alone = scoreReward(s, one).total;
  // Scoring another, much worse candidate first changes nothing.
  scoreReward(s, { accuracy: 500, timeMs: 90_000, costUsd: 3 });
  assert.equal(scoreReward(s, one).total, alone);
});

test("criterion 6: mean and p95 time and mean cost come from each response's observation", () => {
  const observations = [
    ...Array.from({ length: 19 }, () => ({ timing: { task_ms: 100 }, cost: { usd: 0.001 } })),
    { timing: { task_ms: 2000 }, cost: { usd: null, status: "unpriced", reason: "no price" } },
    null,
  ];
  const summary = summarizeObservations(observations);
  assert.equal(summary.timed, 20);
  assert.equal(summary.priced, 19);
  assert.equal(summary.unpriced, 1);
  assert.equal(summary.meanMs, (19 * 100 + 2000) / 20);
  assert.equal(summary.p95Ms, 100);
  assert.ok(Math.abs(summary.meanCostUsd! - 0.001) < 1e-12);
  const tail = summarizeObservations([
    ...Array.from({ length: 18 }, () => ({ timing: { task_ms: 100 } })),
    { timing: { task_ms: 900 } },
    { timing: { task_ms: 1000 } },
  ]);
  assert.equal(tail.p95Ms, 900);
  assert.deepEqual(summarizeObservations([]), {
    timed: 0,
    priced: 0,
    unpriced: 0,
    meanMs: null,
    p95Ms: null,
    meanCostUsd: null,
  });
});
