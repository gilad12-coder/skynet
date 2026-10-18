import assert from "node:assert/strict";
import { test } from "node:test";

import {
  blendBuild,
  buildIssues,
  bundledRewards,
  customReward,
  extractText,
  scoreBuild,
  scoreRule,
  uniqueName,
  type RewardBuild,
} from "./reward-rules.ts";

const [exact, numeric, soft, strict] = bundledRewards("answer");

test("exact-answer normalizes before it compares", () => {
  assert.equal(scoreRule(exact!.rule, " 1,000 ", { answer: "1000" }).score, 2);
  assert.equal(scoreRule(exact!.rule, "Paris", { answer: "paris" }).scaled, 1);
  assert.deepEqual(scoreRule(exact!.rule, "Rome", { answer: "paris" }).reason, { code: "miss" });
  assert.deepEqual(scoreRule(exact!.rule, "x", {}).reason, { code: "no_reference" });
});

test("numeric-close gives band credit by relative error", () => {
  assert.equal(scoreRule(numeric!.rule, "about 100", { answer: "100" }).score, 3);
  assert.equal(scoreRule(numeric!.rule, "108", { answer: "100" }).score, 1.5);
  assert.equal(scoreRule(numeric!.rule, "119", { answer: "100" }).score, 0.5);
  assert.equal(scoreRule(numeric!.rule, "150", { answer: "100" }).score, -1);
  const none = scoreRule(numeric!.rule, "no idea", { answer: "100" });
  assert.equal(none.score, -2);
  assert.equal(none.scaled, 0);
  assert.equal(scoreRule(numeric!.rule, "1", { answer: 0 }).score, -1);
});

test("the XML format rewards match like Unsloth's", () => {
  const reply = "<reasoning>\nadd\n</reasoning>\n<answer>4</answer>";
  assert.equal(scoreRule(soft!.rule, `noise ${reply}`, null).score, 0.5);
  assert.equal(scoreRule(strict!.rule, `  ${reply}\n`, null).score, 0.5);
  assert.equal(scoreRule(strict!.rule, `noise ${reply}`, null).score, 0);
});

test("json_schema checks type and required keys inside the extract", () => {
  const rule = customReward("json_schema", "answer").rule;
  if (rule.type !== "json_schema") throw new Error("type");
  rule.schema.required = ["city"];
  assert.equal(scoreRule(rule, '<answer>{"city": "Haifa"}</answer>', null).score, 1);
  assert.deepEqual(scoreRule(rule, "<answer>{}</answer>", null).reason, {
    code: "missing_key",
    key: "city",
  });
  assert.deepEqual(scoreRule(rule, "<answer>[1]</answer>", null).reason, {
    code: "wrong_type",
    type: "object",
  });
  assert.deepEqual(scoreRule(rule, "<answer>{</answer>", null).reason, { code: "bad_json" });
});

test("length counts characters, not UTF-16 units", () => {
  const rule = customReward("length", "answer").rule;
  if (rule.type !== "length") throw new Error("type");
  rule.max_chars = 3;
  assert.equal(scoreRule(rule, "שלום", null).score, 0);
  assert.equal(scoreRule(rule, "😀😀😀", null).score, 1);
});

test("extractText takes the last between pair and a regex's first group", () => {
  assert.equal(extractText("<a>1</a><a>2</a>", { between: ["<a>", "</a>"] }), "2");
  assert.equal(extractText("x", { between: ["<a>", "</a>"] }), null);
  assert.equal(extractText("total: 42", { regex: "total: (\\d+)" }), "42");
  assert.equal(extractText("abc", { regex: "b" }), "b");
});

test("scoreBuild is the weighted mean of scaled scores", () => {
  const build: RewardBuild = {
    rewards: [
      { ...exact!, weight: 3 },
      { ...soft!, weight: 1 },
    ],
    speed: { weight: 0, reference: 2000 },
    cost: { weight: 0, reference: 0.001 },
  };
  assert.equal(scoreBuild(build, "4", { answer: "4" }).accuracy, 0.75);
  assert.equal(scoreBuild(build, "<answer>4</answer>", { answer: "5" }).accuracy, 0.25);
});

test("blendBuild matches the harness formula and scores unknown time 0", () => {
  const build: RewardBuild = {
    rewards: [{ ...exact!, weight: 2 }],
    speed: { weight: 1, reference: 2000 },
    cost: { weight: 1, reference: 0.001 },
  };
  const blended = blendBuild(build, 1, 2000, null);
  assert.deepEqual(blended.parts, { accuracy: 1, speed: 0.5, cost: 0 });
  assert.equal(blended.total, (2 * 1 + 0.5) / 4);
});

test("buildIssues finds what would break the metric", () => {
  const empty: RewardBuild = {
    rewards: [],
    speed: { weight: 0, reference: 1 },
    cost: { weight: 0, reference: 0 },
  };
  assert.deepEqual(
    buildIssues(empty).map((i) => i.code),
    ["no_rewards", "bad_reference"],
  );
  const bad = customReward("regex", "answer");
  const build: RewardBuild = {
    rewards: [
      bad,
      { ...bad, name: "Bad Name" },
      { ...exact!, weight: 0 },
      { ...exact!, weight: 0 },
    ],
    speed: { weight: 0, reference: 1 },
    cost: { weight: 0, reference: 1 },
  };
  assert.deepEqual(
    buildIssues(build).map((i) => i.code),
    ["bad_pattern", "bad_name", "bad_pattern", "duplicate_name"],
  );
});

test("uniqueName adds a number when the name is taken", () => {
  assert.equal(uniqueName("regex", []), "regex");
  assert.equal(uniqueName("regex", ["regex", "regex-2"]), "regex-3");
});
