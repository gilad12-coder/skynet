import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { RewardBuild } from "./reward-rules.ts";

// Library files import siblings without the .ts ending, as Next.js expects.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !specifier.endsWith(".ts")) {
      return { shortCircuit: true, url: new URL(`${specifier}.ts`, context.parentURL).href };
    }
    return nextResolve(specifier, context);
  },
});

const { readRewardSpec } = await import("./reward.ts");
const { buildToMetricCode, readRewardRules, toPyLiteral } = await import("./reward-rules-code.ts");
const { bundledRewards, customReward, scoreBuild } = await import("./reward-rules.ts");

const FIXTURE = new URL(
  "../../../../backend/core/service_gateway/optimization/blackbox/tests/fixtures/reward_builder_metric.txt",
  import.meta.url,
);

/** The build behind the golden metric that the backend harness test runs. */
function fixtureBuild(): RewardBuild {
  const json = customReward("json_schema", "answer");
  if (json.rule.type === "json_schema") json.rule.schema.required = ["value"];
  const length = customReward("length", "answer");
  return {
    rewards: [
      ...bundledRewards("answer"),
      { ...json, weight: 0.5 },
      { ...length, description: "Short — קצר" },
    ],
    speed: { weight: 1, reference: 2000 },
    cost: { weight: 0.5, reference: 0.001 },
  };
}

const CASES: Array<[string, Record<string, unknown> | null]> = [
  ["<reasoning>\n2+2\n</reasoning>\n<answer>4</answer>", { answer: "4" }],
  ["4", { answer: "4" }],
  ["The answer is 1,080", { answer: "1000" }],
  ['<answer>{"value": 3}</answer>', { answer: 3 }],
  ["nothing", { answer: "Paris" }],
  ["x".repeat(600), null],
  ["  PARIS  ", { answer: "paris" }],
];

test("the golden fixture is what the builder writes", () => {
  assert.equal(buildToMetricCode(fixtureBuild()), readFileSync(FIXTURE, "utf8"));
});

test("the metric reads back to the same build", () => {
  const build = fixtureBuild();
  const read = readRewardRules(buildToMetricCode(build), "answer");
  assert.deepEqual(read, { kind: "build", build });
});

test("the written REWARD_SPEC is valid and weighs rules, speed and cost", () => {
  const read = readRewardSpec(buildToMetricCode(fixtureBuild()));
  assert.equal(read.kind, "spec");
  if (read.kind !== "spec") return;
  assert.deepEqual(read.spec.weights, { accuracy: 5.5 / 7, speed: 1 / 7, cost: 0.5 / 7 });
});

test("readRewardRules says none or invalid", () => {
  assert.deepEqual(readRewardRules("def score(i, o):\n    return 1\n", "answer"), { kind: "none" });
  assert.deepEqual(readRewardRules("REWARD_RULES = [{'name': 'x'}]\n", "answer"), {
    kind: "invalid",
  });
  assert.deepEqual(readRewardRules("REWARD_RULES = make_rules()\n", "answer"), { kind: "invalid" });
});

test("toPyLiteral writes Python values", () => {
  assert.equal(
    toPyLiteral({ a: [1, true, null], b: 'q"\n' }),
    '{\n    "a": [1, True, None],\n    "b": "q\\"\\n",\n}',
  );
});

test("the Python evaluator scores like the TS one", () => {
  const build = fixtureBuild();
  const dir = mkdtempSync(join(tmpdir(), "reward-parity-"));
  mkdirSync(join(dir, "skynet"));
  writeFileSync(
    join(dir, "skynet", "__init__.py"),
    "def reward(spec, accuracy, feedback=''):\n    return accuracy\n",
  );
  writeFileSync(join(dir, "metric.py"), buildToMetricCode(build));
  writeFileSync(join(dir, "cases.json"), JSON.stringify(CASES));
  const script =
    "import json, sys\nsys.path.insert(0, sys.argv[1])\nimport metric\n" +
    "cases = json.load(open(sys.argv[1] + '/cases.json'))\n" +
    "print(json.dumps([metric.score({}, reply, expected) for reply, expected in cases]))\n";
  const out = execFileSync("python3", ["-I", "-c", script, dir], { encoding: "utf8" });
  const python = JSON.parse(out) as number[];
  const ts = CASES.map(([reply, expected]) => scoreBuild(build, reply, expected).accuracy);
  python.forEach((value, i) =>
    assert.ok(Math.abs(value - ts[i]!) < 1e-9, `case ${i}: ${value} vs ${ts[i]}`),
  );
  assert.ok(new Set(ts).size > 3, "the cases cover different scores");
});
