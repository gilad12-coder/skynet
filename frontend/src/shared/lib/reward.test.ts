import assert from "node:assert/strict";
import { test } from "node:test";

import { readRewardSpec, summarizeObservations, type RewardSpec } from "./reward.ts";

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

test("criterion 6: mean time and mean cost come from each response's observation", () => {
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
  assert.ok(Math.abs(summary.meanCostUsd! - 0.001) < 1e-12);
  assert.deepEqual(summarizeObservations([]), {
    timed: 0,
    priced: 0,
    unpriced: 0,
    meanMs: null,
    meanCostUsd: null,
  });
});
