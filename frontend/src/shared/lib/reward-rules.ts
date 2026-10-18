/**
 * The reward builder's rules (SKY-84): the model, the bundled rewards and the
 * evaluator behind "Try it".
 *
 * A built reward is a list of rule rewards plus the speed and cost parts of
 * the SKY-69 `REWARD_SPEC`. Each rule scores a reply; its score is scaled to
 * 0-1 between the lowest and the highest score the rule can give, and the
 * accuracy is the weighted mean of those. `reward-rules-code.ts` writes the
 * same rules and the same evaluator into metric.py, so the preview and the run
 * score a reply alike. No imports: `node --test` loads it as is.
 */

export type NormalizeOp = "strip" | "lower" | "remove_commas" | "collapse_spaces";

export const NORMALIZE_OPS: readonly NormalizeOp[] = [
  "strip",
  "lower",
  "remove_commas",
  "collapse_spaces",
];

/** Where in a text the rule looks: the last `between` pair, or a regex's first group. */
export type Extract = { between: [string, string] } | { regex: string };

export type JsonType = "object" | "array" | "string" | "number";

export const JSON_TYPES: readonly JsonType[] = ["object", "array", "string", "number"];

export type RewardRule =
  | {
      type: "regex";
      pattern: string;
      mode: "search" | "fullmatch";
      score: { match: number; miss: number };
    }
  | {
      type: "exact_match";
      extract?: Extract;
      compare_to: string;
      reference_extract?: Extract;
      normalize: NormalizeOp[];
      score: { match: number; miss: number };
      missing: number;
    }
  | {
      type: "numeric";
      extract?: Extract;
      compare_to: string;
      reference_extract?: Extract;
      bands: Array<{ within: number; score: number }>;
      else: number;
      missing: number;
    }
  | {
      type: "json_schema";
      extract?: Extract;
      schema: { type: JsonType; required: string[] };
      score: { match: number; miss: number };
    }
  | {
      type: "length";
      max_chars: number;
      score: { under: number; over: number };
    };

export type RuleType = RewardRule["type"];

export const RULE_TYPES: readonly RuleType[] = [
  "exact_match",
  "numeric",
  "regex",
  "json_schema",
  "length",
];

export interface RewardEntry {
  /** A slug, unique in the build: the REWARD.md `name`. */
  name: string;
  description: string;
  /** Bundled with Skynet, or written or imported by the user. */
  source: "bundled" | "yours";
  weight: number;
  rule: RewardRule;
}

export interface RewardPart {
  weight: number;
  /** The value that scores half: milliseconds for speed, USD for cost. */
  reference: number;
}

export interface RewardBuild {
  rewards: RewardEntry[];
  speed: RewardPart;
  cost: RewardPart;
}

export type Expected = Record<string, unknown> | null | undefined;

export type RuleReason =
  | { code: "match" | "miss" | "no_answer" | "no_reference" | "bad_pattern" | "outside" }
  | { code: "band"; within: number }
  | { code: "bad_json" | "wrong_type"; type?: JsonType }
  | { code: "missing_key"; key: string }
  | { code: "under" | "over"; chars: number; max: number };

export interface RuleResult {
  score: number;
  /** The score scaled to 0-1 between the rule's lowest and highest score. */
  scaled: number;
  reason: RuleReason;
}

export const DEFAULT_SPEED: RewardPart = { weight: 0, reference: 2000 };
export const DEFAULT_COST: RewardPart = { weight: 0, reference: 0.001 };

export const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const ANSWER_TAGS: [string, string] = ["<answer>", "</answer>"];

/**
 * The bundled rewards, after Unsloth Studio's four (PR 14074).
 *
 * exact-answer and numeric-close read the whole reply and compare it with the
 * run's expected column; Unsloth's GSM8K `reference_extract` is left out
 * because a Skynet expected value is the plain answer.
 */
export function bundledRewards(expectedField: string): RewardEntry[] {
  return [
    {
      name: "exact-answer",
      description: "The reply equals the expected answer.",
      source: "bundled",
      weight: 1,
      rule: {
        type: "exact_match",
        compare_to: expectedField,
        normalize: ["strip", "remove_commas", "lower"],
        score: { match: 2, miss: 0 },
        missing: 0,
      },
    },
    {
      name: "numeric-close",
      description: "Partial credit when the number in the reply is close to the expected answer.",
      source: "bundled",
      weight: 1,
      rule: {
        type: "numeric",
        compare_to: expectedField,
        bands: [
          { within: 0, score: 3 },
          { within: 0.1, score: 1.5 },
          { within: 0.2, score: 0.5 },
        ],
        else: -1,
        missing: -2,
      },
    },
    {
      name: "soft-xml-format",
      description: "An <answer>...</answer> block appears anywhere in the reply.",
      source: "bundled",
      weight: 1,
      rule: {
        type: "regex",
        mode: "search",
        pattern: "<answer>.*?</answer>",
        score: { match: 0.5, miss: 0 },
      },
    },
    {
      name: "strict-xml-format",
      description:
        "The whole reply is <reasoning>...</reasoning> followed by <answer>...</answer>.",
      source: "bundled",
      weight: 1,
      rule: {
        type: "regex",
        mode: "fullmatch",
        pattern: "<reasoning>.*?</reasoning>\\s*<answer>.*?</answer>",
        score: { match: 0.5, miss: 0 },
      },
    },
  ];
}

/** A new custom reward of one rule type, with defaults the user then edits. */
export function customReward(type: RuleType, expectedField: string): RewardEntry {
  const rule: RewardRule =
    type === "regex"
      ? { type, mode: "search", pattern: "", score: { match: 1, miss: 0 } }
      : type === "exact_match"
        ? {
            type,
            compare_to: expectedField,
            normalize: ["strip", "lower"],
            score: { match: 1, miss: 0 },
            missing: 0,
          }
        : type === "numeric"
          ? {
              type,
              compare_to: expectedField,
              bands: [{ within: 0, score: 1 }],
              else: 0,
              missing: 0,
            }
          : type === "json_schema"
            ? {
                type,
                extract: { between: ANSWER_TAGS },
                schema: { type: "object", required: [] },
                score: { match: 1, miss: 0 },
              }
            : { type, max_chars: 500, score: { under: 1, over: 0 } };
  return { name: type.replace(/_/g, "-"), description: "", source: "yours", weight: 1, rule };
}

/** `name`, or `name-2`, `name-3`... so it is unique among `taken`. */
export function uniqueName(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(name)) return name;
  for (let n = 2; ; n++) if (!used.has(`${name}-${n}`)) return `${name}-${n}`;
}

/** The lowest and the highest score a rule can give. */
export function ruleRange(rule: RewardRule): { min: number; max: number } {
  const scores =
    rule.type === "regex" || rule.type === "json_schema"
      ? [rule.score.match, rule.score.miss]
      : rule.type === "exact_match"
        ? [rule.score.match, rule.score.miss, rule.missing]
        : rule.type === "numeric"
          ? [...rule.bands.map((b) => b.score), rule.else, rule.missing]
          : [rule.score.under, rule.score.over];
  return { min: Math.min(...scores), max: Math.max(...scores) };
}

function regex(pattern: string, anchored = false): RegExp | null {
  try {
    // Python's re.S | re.M, as Unsloth compiles a pattern. The lookarounds
    // anchor at the very start and end, which ^ and $ do not under re.M.
    return new RegExp(anchored ? `(?<![\\s\\S])(?:${pattern})(?![\\s\\S])` : pattern, "ms");
  } catch {
    return null;
  }
}

/** The part of `text` an extract selects, or `null` when it finds none. */
export function extractText(text: string, extract: Extract | undefined): string | null {
  if (!extract) return text;
  if ("between" in extract) {
    const [open, close] = extract.between;
    const at = text.lastIndexOf(open);
    if (at < 0) return null;
    const start = at + open.length;
    const end = text.indexOf(close, start);
    return end < 0 ? null : text.slice(start, end);
  }
  const found = regex(extract.regex)?.exec(text);
  if (!found) return null;
  return found.length > 1 ? (found[1] ?? "") : found[0];
}

/** The text of an expected value: a string as is, anything else as JSON. */
export function expectedText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function normalize(text: string, ops: readonly NormalizeOp[]): string {
  let out = text;
  for (const op of ops) {
    if (op === "strip") out = out.trim();
    else if (op === "lower") out = out.toLowerCase();
    else if (op === "remove_commas") out = out.replace(/,/g, "");
    else out = out.replace(/\s+/g, " ");
  }
  return out;
}

const NUMBER = /-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/;

/** The first number in `text`, commas dropped; `null` when it has none. */
export function firstNumber(text: string): number | null {
  const found = NUMBER.exec(text.replace(/,/g, ""));
  return found ? Number(found[0]) : null;
}

function jsonTypeOf(value: unknown): JsonType | null {
  if (Array.isArray(value)) return "array";
  if (value !== null && typeof value === "object") return "object";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  return null;
}

function rawScore(rule: RewardRule, text: string, expected: Expected): [number, RuleReason] {
  if (rule.type === "regex") {
    const pattern = regex(rule.pattern, rule.mode === "fullmatch");
    if (!pattern) return [rule.score.miss, { code: "bad_pattern" }];
    const subject = rule.mode === "fullmatch" ? text.trim() : text;
    return pattern.test(subject)
      ? [rule.score.match, { code: "match" }]
      : [rule.score.miss, { code: "miss" }];
  }
  if (rule.type === "length") {
    const chars = [...text].length;
    return chars <= rule.max_chars
      ? [rule.score.under, { code: "under", chars, max: rule.max_chars }]
      : [rule.score.over, { code: "over", chars, max: rule.max_chars }];
  }
  const answer = extractText(text, rule.extract);
  if (rule.type === "json_schema") {
    if (answer === null) return [rule.score.miss, { code: "no_answer" }];
    let value: unknown;
    try {
      value = JSON.parse(answer);
    } catch {
      return [rule.score.miss, { code: "bad_json" }];
    }
    if (jsonTypeOf(value) !== rule.schema.type) {
      return [rule.score.miss, { code: "wrong_type", type: rule.schema.type }];
    }
    if (rule.schema.type === "object") {
      const missingKey = rule.schema.required.find(
        (key) => !Object.prototype.hasOwnProperty.call(value, key),
      );
      if (missingKey !== undefined)
        return [rule.score.miss, { code: "missing_key", key: missingKey }];
    }
    return [rule.score.match, { code: "match" }];
  }
  const raw = expected?.[rule.compare_to];
  const reference =
    raw === undefined || raw === null
      ? null
      : extractText(expectedText(raw), rule.reference_extract);
  if (reference === null) return [rule.missing, { code: "no_reference" }];
  if (answer === null) return [rule.missing, { code: "no_answer" }];
  if (rule.type === "exact_match") {
    return normalize(answer, rule.normalize) === normalize(reference, rule.normalize)
      ? [rule.score.match, { code: "match" }]
      : [rule.score.miss, { code: "miss" }];
  }
  const got = firstNumber(answer);
  const truth = firstNumber(reference);
  if (truth === null) return [rule.missing, { code: "no_reference" }];
  if (got === null) return [rule.missing, { code: "no_answer" }];
  const error = truth === 0 ? Math.abs(got - truth) : Math.abs(got - truth) / Math.abs(truth);
  const bands = [...rule.bands].sort((a, b) => a.within - b.within);
  for (const band of bands) {
    if (error <= band.within + 1e-12) return [band.score, { code: "band", within: band.within }];
  }
  return [rule.else, { code: "outside" }];
}

/** Score one reply under one rule. */
export function scoreRule(rule: RewardRule, reply: string, expected: Expected): RuleResult {
  const [score, reason] = rawScore(rule, reply, expected);
  const { min, max } = ruleRange(rule);
  return { score, scaled: max > min ? (score - min) / (max - min) : 1, reason };
}

export interface BuildResult {
  rules: Array<{ entry: RewardEntry; result: RuleResult }>;
  /** The weighted mean of the scaled rule scores, 0-1. */
  accuracy: number;
}

/** Score one reply under every rule of a build. */
export function scoreBuild(build: RewardBuild, reply: string, expected: Expected): BuildResult {
  const rules = build.rewards.map((entry) => ({
    entry,
    result: scoreRule(entry.rule, reply, expected),
  }));
  const total = rules.reduce((sum, r) => sum + Math.max(r.entry.weight, 0), 0);
  const accuracy =
    total > 0
      ? rules.reduce((sum, r) => sum + Math.max(r.entry.weight, 0) * r.result.scaled, 0) / total
      : 0;
  return { rules, accuracy };
}

/** The total weight of a build: its rules', its speed's and its cost's. */
export function buildWeight(build: RewardBuild): number {
  return (
    build.rewards.reduce((sum, r) => sum + Math.max(r.weight, 0), 0) +
    build.speed.weight +
    build.cost.weight
  );
}

/** `reference / (reference + value)`: the harness's `reference_utility`. */
export function referenceUtility(value: number, reference: number): number {
  return reference / (reference + Math.max(value, 0));
}

export interface BlendedReward {
  total: number;
  parts: { accuracy: number; speed: number; cost: number };
}

/**
 * The run's reward for one reply, as the harness's `blend_reward` scores it:
 * an unknown time or cost scores 0 on its part.
 */
export function blendBuild(
  build: RewardBuild,
  accuracy: number,
  timeMs: number | null,
  costUsd: number | null,
): BlendedReward {
  const total = buildWeight(build);
  const ruleWeight = total - build.speed.weight - build.cost.weight;
  const parts = {
    accuracy: Math.min(Math.max(accuracy, 0), 1),
    speed: timeMs == null ? 0 : referenceUtility(timeMs, build.speed.reference),
    cost: costUsd == null ? 0 : referenceUtility(costUsd, build.cost.reference),
  };
  if (!(total > 0)) return { total: 0, parts };
  return {
    total:
      (ruleWeight * parts.accuracy +
        build.speed.weight * parts.speed +
        build.cost.weight * parts.cost) /
      total,
    parts,
  };
}

export type BuildIssue =
  | { code: "no_rewards" | "no_weight" }
  | { code: "bad_name" | "duplicate_name"; name: string }
  | { code: "bad_pattern" | "no_bands"; name: string }
  | { code: "bad_reference"; part: "speed" | "cost" };

/** What stops a build from becoming a valid metric; empty when nothing does. */
export function buildIssues(build: RewardBuild): BuildIssue[] {
  const issues: BuildIssue[] = [];
  if (build.rewards.length === 0) issues.push({ code: "no_rewards" });
  else if (!(buildWeight(build) > 0)) issues.push({ code: "no_weight" });
  const seen = new Set<string>();
  for (const { name, rule } of build.rewards) {
    if (!NAME_PATTERN.test(name)) issues.push({ code: "bad_name", name });
    else if (seen.has(name)) issues.push({ code: "duplicate_name", name });
    seen.add(name);
    const patterns =
      rule.type === "regex"
        ? [rule.pattern]
        : "extract" in rule && rule.extract && "regex" in rule.extract
          ? [rule.extract.regex]
          : [];
    if (patterns.some((p) => !p || regex(p) === null)) issues.push({ code: "bad_pattern", name });
    if (rule.type === "numeric" && rule.bands.length === 0) issues.push({ code: "no_bands", name });
  }
  for (const part of ["speed", "cost"] as const) {
    if (!(build[part].reference > 0) || !Number.isFinite(build[part].reference)) {
      issues.push({ code: "bad_reference", part });
    }
  }
  return issues;
}
