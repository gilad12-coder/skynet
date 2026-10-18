import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

// Library files import siblings without the .ts ending, as Next.js expects.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !specifier.endsWith(".ts")) {
      return { shortCircuit: true, url: new URL(`${specifier}.ts`, context.parentURL).href };
    }
    return nextResolve(specifier, context);
  },
});

const { parseYaml, rewardFromMarkdown, rewardToMarkdown } = await import("./reward-md.ts");
const { bundledRewards, customReward, scoreRule } = await import("./reward-rules.ts");

// Unsloth Studio's bundled files (PR 14074), as Studio exports them.
const UNSLOTH_EXACT = `---
name: exact-answer
kind: rule
description: The text inside <answer> equals the dataset's answer column.
---
type: exact_match
extract: {between: ['<answer>', '</answer>']}
compare_to: answer
reference_extract: {regex: '####\\s*(.+?)\\s*$'}
normalize: [strip, remove_commas, lower]
score: {match: 2.0, miss: 0.0}
missing: 0.0
`;

const UNSLOTH_NUMERIC = `---
name: numeric-close
kind: rule
description: Partial credit when the number inside <answer> is close to the dataset's answer.
---
type: numeric
extract: {between: ['<answer>', '</answer>']}
compare_to: answer
reference_extract: {regex: '####\\s*(.+?)\\s*$'}
bands:
  - {within: 0.0, score: 3.0}
  - {within: 0.1, score: 1.5}
  - {within: 0.2, score: 0.5}
else: -1.0
missing: -2.0
`;

const UNSLOTH_STRICT = `---
name: strict-xml-format
kind: rule
description: The whole reply is <reasoning>...</reasoning> followed by <answer>...</answer>.
---
type: regex
mode: fullmatch
pattern: '<reasoning>.*?</reasoning>\\s*<answer>.*?</answer>'
score: {match: 0.5, miss: 0.0}
`;

test("Unsloth's bundled files import and score like Studio", () => {
  const exact = rewardFromMarkdown(UNSLOTH_EXACT, "label");
  assert.ok(exact.ok);
  if (!exact.ok) return;
  assert.equal(exact.entry.name, "exact-answer");
  assert.equal(
    exact.entry.description,
    "The text inside <answer> equals the dataset's answer column.",
  );
  const gsm = { answer: "She pays 3 * 24 = 72\n#### 72" };
  assert.equal(scoreRule(exact.entry.rule, "<answer> 72 </answer>", gsm).score, 2);

  const numeric = rewardFromMarkdown(UNSLOTH_NUMERIC, "label");
  assert.ok(numeric.ok);
  if (!numeric.ok) return;
  assert.equal(numeric.entry.rule.type === "numeric" && numeric.entry.rule.bands.length, 3);
  assert.equal(scoreRule(numeric.entry.rule, "<answer>79</answer>", gsm).score, 1.5);

  const strict = rewardFromMarkdown(UNSLOTH_STRICT, "label");
  assert.ok(strict.ok);
  if (!strict.ok) return;
  assert.equal(
    scoreRule(strict.entry.rule, "<reasoning>a</reasoning>\n<answer>b</answer>", null).score,
    0.5,
  );
});

test("every bundled and custom reward round-trips through REWARD.md", () => {
  const entries = [
    ...bundledRewards("answer"),
    ...(["regex", "exact_match", "numeric", "json_schema", "length"] as const).map((t) =>
      customReward(t, "answer"),
    ),
    {
      ...customReward("regex", "answer"),
      description: "It's: #1 — עברית",
      rule: {
        type: "regex" as const,
        mode: "search" as const,
        pattern: "a'b #c",
        score: { match: 1, miss: -0.5 },
      },
    },
  ];
  for (const entry of entries) {
    const read = rewardFromMarkdown(rewardToMarkdown(entry), "answer");
    assert.ok(read.ok, entry.name);
    if (!read.ok) continue;
    assert.deepEqual(read.entry, {
      name: entry.name,
      description: entry.description,
      source: "yours",
      rule: entry.rule,
    });
  }
});

test("text with line breaks round-trips through REWARD.md", () => {
  const entry = customReward("exact_match", "answer");
  if (entry.rule.type !== "exact_match") return;
  entry.rule.extract = { between: ["<answer>\n", "\n</answer>"] };
  entry.description = "Line one\nLine 'two' with \"quotes\" and \\";
  const read = rewardFromMarkdown(rewardToMarkdown(entry), "answer");
  assert.ok(read.ok);
  if (!read.ok) return;
  assert.deepEqual(read.entry.rule, entry.rule);
  assert.equal(read.entry.description, entry.description);
});

test("defaults follow Unsloth: compare_to, normalize, missing scores", () => {
  const read = rewardFromMarkdown("---\nname: x\n---\ntype: exact_match\n", "label");
  assert.ok(read.ok);
  if (!read.ok) return;
  assert.deepEqual(read.entry.rule, {
    type: "exact_match",
    compare_to: "label",
    normalize: ["strip"],
    score: { match: 0, miss: 0 },
    missing: 0,
  });
});

test("bad files say why", () => {
  const cases: Array<[string, string]> = [
    ["type: regex\n", "no_frontmatter"],
    ["---\nname: x\ntype: regex\n", "unclosed_frontmatter"],
    ["---\nname: x\nkind: python\n---\ndef reward(): pass\n", "python_kind"],
    ["---\nname: x\nkind: model\n---\ntype: regex\n", "unknown_kind"],
    ["---\nname: Bad Name\n---\ntype: regex\npattern: a\n", "bad_name"],
    ["---\nname: x\n---\ntype: numeric\nbands: []\n", "bad_rule"],
    ["---\nname: x\n---\ntype: regex\npattern: 'a\n", "bad_yaml"],
    ["---\nname: x\n---\n- a\n", "not_mapping"],
  ];
  for (const [source, error] of cases) {
    const read = rewardFromMarkdown(source, "answer");
    assert.equal(read.ok ? "ok" : read.error, error, source);
  }
});

test("parseYaml reads block maps, lists, comments and quotes", () => {
  assert.deepEqual(
    parseYaml(
      "a: 1 # note\nb:\n  c: 'it''s'\n  d: \"x\\ny\"\nlist:\n- 1\n- within: 2\n  score: 3\nflow: {k: [1, two, null]}\n",
    ),
    {
      a: 1,
      b: { c: "it's", d: "x\ny" },
      list: [1, { within: 2, score: 3 }],
      flow: { k: [1, "two", null] },
    },
  );
});
