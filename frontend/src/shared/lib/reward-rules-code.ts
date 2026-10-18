/**
 * Write a reward build as metric code, and read it back (SKY-84).
 *
 * The builder keeps no state of its own: its rewards live in metric.py as a
 * plain `REWARD_RULES = [...]` literal next to the SKY-69 `REWARD_SPEC`, and a
 * fixed evaluator turns them into the accuracy that `reward()` blends. The
 * evaluator mirrors `scoreBuild` in `reward-rules.ts` line for line, so "Try
 * it" and the run score a reply alike.
 */

import { parsePyLiteral, type PyValue } from "./reward.ts";
import {
  DEFAULT_COST,
  DEFAULT_SPEED,
  JSON_TYPES,
  NORMALIZE_OPS,
  RULE_TYPES,
  type Extract,
  type JsonType,
  type NormalizeOp,
  type RewardBuild,
  type RewardEntry,
  type RewardPart,
  type RewardRule,
  type RuleType,
} from "./reward-rules.ts";

/** One value as a Python literal. JSON string escapes are valid Python escapes. */
export function toPyLiteral(value: unknown, indent = 0): string {
  const pad = " ".repeat(indent + 4);
  const end = " ".repeat(indent);
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("A reward value must be a finite number");
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.every((v) => typeof v !== "object" || v === null)) {
      return `[${value.map((v) => toPyLiteral(v)).join(", ")}]`;
    }
    return `[\n${value.map((v) => `${pad}${toPyLiteral(v, indent + 4)},`).join("\n")}\n${end}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return "{}";
  return `{\n${entries
    .map(([k, v]) => `${pad}${JSON.stringify(k)}: ${toPyLiteral(v, indent + 4)},`)
    .join("\n")}\n${end}}`;
}

const EVALUATOR = String.raw`_NUMBER = r"-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?"


def _extract(text, extract):
    if not extract:
        return text
    if "between" in extract:
        start_tag, end_tag = extract["between"]
        at = text.rfind(start_tag)
        if at < 0:
            return None
        start = at + len(start_tag)
        end = text.find(end_tag, start)
        return None if end < 0 else text[start:end]
    try:
        found = re.search(extract["regex"], text, re.S)
    except re.error:
        return None
    if not found:
        return None
    return (found.group(1) or "") if found.re.groups else found.group(0)


def _expected_text(value):
    return value if isinstance(value, str) else json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def _normalize(text, ops):
    for op in ops:
        if op == "strip":
            text = text.strip()
        elif op == "lower":
            text = text.lower()
        elif op == "remove_commas":
            text = text.replace(",", "")
        else:
            text = re.sub(r"\s+", " ", text)
    return text


def _first_number(text):
    found = re.search(_NUMBER, text.replace(",", ""))
    return float(found.group(0)) if found else None


def _json_type(value):
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    if isinstance(value, str):
        return "string"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return "number"
    return None


def _range(rule):
    kind = rule["type"]
    if kind in ("regex", "json_schema"):
        scores = [rule["score"]["match"], rule["score"]["miss"]]
    elif kind == "exact_match":
        scores = [rule["score"]["match"], rule["score"]["miss"], rule["missing"]]
    elif kind == "numeric":
        scores = [band["score"] for band in rule["bands"]] + [rule["else"], rule["missing"]]
    else:
        scores = [rule["score"]["under"], rule["score"]["over"]]
    return min(scores), max(scores)


def _raw_score(rule, text, expected):
    kind = rule["type"]
    if kind == "regex":
        try:
            if rule["mode"] == "fullmatch":
                found = re.fullmatch(rule["pattern"], text.strip(), re.S)
            else:
                found = re.search(rule["pattern"], text, re.S)
        except re.error:
            return rule["score"]["miss"], "bad pattern"
        return (rule["score"]["match"], "match") if found else (rule["score"]["miss"], "no match")
    if kind == "length":
        chars = len(text)
        if chars <= rule["max_chars"]:
            return rule["score"]["under"], f"{chars} chars, at most {rule['max_chars']}"
        return rule["score"]["over"], f"{chars} chars, over {rule['max_chars']}"
    answer = _extract(text, rule.get("extract"))
    if kind == "json_schema":
        if answer is None:
            return rule["score"]["miss"], "no answer found"
        try:
            value = json.loads(answer)
        except ValueError:
            return rule["score"]["miss"], "not valid JSON"
        if _json_type(value) != rule["schema"]["type"]:
            return rule["score"]["miss"], f"not a JSON {rule['schema']['type']}"
        if rule["schema"]["type"] == "object":
            for key in rule["schema"]["required"]:
                if key not in value:
                    return rule["score"]["miss"], f"missing key {key}"
        return rule["score"]["match"], "match"
    raw = (expected or {}).get(rule["compare_to"])
    reference = None if raw is None else _extract(_expected_text(raw), rule.get("reference_extract"))
    if reference is None:
        return rule["missing"], "no expected value"
    if answer is None:
        return rule["missing"], "no answer found"
    if kind == "exact_match":
        if _normalize(answer, rule["normalize"]) == _normalize(reference, rule["normalize"]):
            return rule["score"]["match"], "match"
        return rule["score"]["miss"], "no match"
    got = _first_number(answer)
    truth = _first_number(reference)
    if truth is None:
        return rule["missing"], "no expected number"
    if got is None:
        return rule["missing"], "no number found"
    error = abs(got - truth) if truth == 0 else abs(got - truth) / abs(truth)
    for band in sorted(rule["bands"], key=lambda band: band["within"]):
        if error <= band["within"] + 1e-12:
            return band["score"], f"within {band['within']:g}"
    return rule["else"], "outside every band"


def rule_accuracy(text, expected):
    """Score a reply under every rule; return the 0-1 accuracy and one line per rule."""
    total = 0.0
    weighted = 0.0
    lines = []
    for entry in REWARD_RULES:
        score, reason = _raw_score(entry["rule"], text, expected)
        low, high = _range(entry["rule"])
        scaled = (score - low) / (high - low) if high > low else 1.0
        weight = max(entry["weight"], 0)
        total += weight
        weighted += weight * scaled
        lines.append(f"{entry['name']} {score:g} ({reason})")
    return (weighted / total if total > 0 else 0.0), "; ".join(lines)


def score(input, output, expected=None):
    text = "" if output is None else str(output)
    accuracy, feedback = rule_accuracy(text, expected)
    return reward(REWARD_SPEC, accuracy, feedback)
`;

const HEADER = `"""A reward made in Skynet's reward builder.

The builder's UI mode reads REWARD_RULES back and rewrites this file, so
change the rewards there. Each rule's score is scaled to 0-1 between its
lowest and highest score; the accuracy is their weighted mean, and reward()
blends it with speed and cost under REWARD_SPEC.
"""

import json
import re

from skynet import reward
`;

function ruleWeight(build: RewardBuild): number {
  return build.rewards.reduce((sum, r) => sum + Math.max(r.weight, 0), 0);
}

/** The metric.py for a build. */
export function buildToMetricCode(build: RewardBuild): string {
  const spec = {
    weights: { accuracy: ruleWeight(build), speed: build.speed.weight, cost: build.cost.weight },
    accuracy: { meaning: "Weighted mean of the reward rules, 0 to 1", unit: "" },
    speed: { meaning: "Run time of one response", unit: "ms", reference: build.speed.reference },
    cost: { meaning: "Model cost of one response", unit: "USD", reference: build.cost.reference },
  };
  const rules = build.rewards.map(({ name, description, source, weight, rule }) => ({
    name,
    description,
    source,
    weight,
    rule,
  }));
  return `${HEADER}\nREWARD_SPEC = ${toPyLiteral(spec)}\n\nREWARD_RULES = ${toPyLiteral(rules)}\n\n\n${EVALUATOR}`;
}

export type RewardRulesRead =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "build"; build: RewardBuild };

function isRecord(value: unknown): value is Record<string, PyValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** A literal's raw `extract` value as an Extract; `undefined` when absent, `null` when malformed. */
export function extractFrom(value: unknown): Extract | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) return null;
  if (Array.isArray(value.between)) {
    const [open, close] = value.between;
    return typeof open === "string" && typeof close === "string" && value.between.length === 2
      ? { between: [open, close] }
      : null;
  }
  const pattern = str(value.regex);
  return pattern === null ? null : { regex: pattern };
}

function scorePair<K extends string>(value: unknown, keys: [K, K]): Record<K, number> | null {
  if (!isRecord(value)) return null;
  const out = {} as Record<K, number>;
  for (const key of keys) {
    const n = num(value[key]);
    if (n === null) return null;
    out[key] = n;
  }
  return out;
}

/**
 * Validate one raw rule (from metric code or a REWARD.md body) into a RewardRule.
 *
 * Returns `null` when a field is missing or of the wrong type. `compare_to`
 * defaults to `expectedField`.
 */
export function ruleFrom(raw: unknown, expectedField: string): RewardRule | null {
  if (!isRecord(raw)) return null;
  const type = str(raw.type) as RuleType | null;
  if (!type || !RULE_TYPES.includes(type)) return null;
  if (type === "regex") {
    const pattern = str(raw.pattern);
    const mode = raw.mode ?? "fullmatch";
    const score = scorePair(raw.score, ["match", "miss"]);
    if (pattern === null || (mode !== "search" && mode !== "fullmatch") || !score) return null;
    return { type, pattern, mode, score };
  }
  if (type === "length") {
    const max = num(raw.max_chars);
    const score = scorePair(raw.score, ["under", "over"]);
    if (max === null || max < 0 || !score) return null;
    return { type, max_chars: max, score };
  }
  const extract = extractFrom(raw.extract);
  if (extract === null) return null;
  if (type === "json_schema") {
    const schema = raw.schema;
    const score = scorePair(raw.score, ["match", "miss"]);
    if (!isRecord(schema) || !score) return null;
    const schemaType = str(schema.type) as JsonType | null;
    const required = schema.required ?? [];
    if (!schemaType || !JSON_TYPES.includes(schemaType) || !Array.isArray(required)) return null;
    if (!required.every((k) => typeof k === "string")) return null;
    return {
      type,
      ...(extract ? { extract } : {}),
      schema: { type: schemaType, required: required as string[] },
      score,
    };
  }
  const compareTo = raw.compare_to === undefined ? expectedField : str(raw.compare_to);
  const referenceExtract = extractFrom(raw.reference_extract);
  const missing = raw.missing === undefined ? 0 : num(raw.missing);
  if (compareTo === null || referenceExtract === null || missing === null) return null;
  const shared = {
    ...(extract ? { extract } : {}),
    compare_to: compareTo,
    ...(referenceExtract ? { reference_extract: referenceExtract } : {}),
  };
  if (type === "exact_match") {
    const ops = raw.normalize ?? [];
    const score = scorePair(raw.score, ["match", "miss"]);
    if (!Array.isArray(ops) || !score) return null;
    if (!ops.every((op) => NORMALIZE_OPS.includes(op as NormalizeOp))) return null;
    return { type, ...shared, normalize: ops as NormalizeOp[], score, missing };
  }
  const bands = raw.bands;
  const otherwise = raw.else === undefined ? 0 : num(raw.else);
  if (!Array.isArray(bands) || otherwise === null) return null;
  const parsed: Array<{ within: number; score: number }> = [];
  for (const band of bands) {
    if (!isRecord(band)) return null;
    const within = num(band.within);
    const score = num(band.score);
    if (within === null || within < 0 || score === null) return null;
    parsed.push({ within, score });
  }
  return { type, ...shared, bands: parsed, else: otherwise, missing };
}

function partFrom(spec: Record<string, PyValue>, name: "speed" | "cost", base: RewardPart): RewardPart {
  const weights = isRecord(spec.weights) ? spec.weights : {};
  const part = isRecord(spec[name]) ? spec[name] : {};
  return {
    weight: num(weights[name]) ?? base.weight,
    reference: num((part as Record<string, PyValue>).reference) ?? base.reference,
  };
}

function literalAfter(code: string, name: string): PyValue | undefined {
  const match = new RegExp(`^${name}\\s*(?::[^=\\n]*)?=\\s*`, "m").exec(code);
  if (!match) return undefined;
  return parsePyLiteral(code, match.index + match[0].length)?.value;
}

/**
 * Read a builder metric's `REWARD_RULES` and `REWARD_SPEC` back into a build.
 *
 * `none` when the code has no `REWARD_RULES`; `invalid` when it has one the
 * builder cannot read (for example after a hand edit).
 */
export function readRewardRules(code: string | null | undefined, expectedField: string): RewardRulesRead {
  if (!code || !/^REWARD_RULES\s*(?::[^=\n]*)?=/m.test(code)) return { kind: "none" };
  const rawRules = literalAfter(code, "REWARD_RULES");
  if (!Array.isArray(rawRules)) return { kind: "invalid" };
  const rewards: RewardEntry[] = [];
  for (const raw of rawRules) {
    if (!isRecord(raw)) return { kind: "invalid" };
    const name = str(raw.name);
    const weight = num(raw.weight);
    const rule = ruleFrom(raw.rule, expectedField);
    if (name === null || weight === null || !rule) return { kind: "invalid" };
    rewards.push({
      name,
      description: str(raw.description) ?? "",
      source: raw.source === "bundled" ? "bundled" : "yours",
      weight,
      rule,
    });
  }
  const spec = literalAfter(code, "REWARD_SPEC");
  const specRecord = isRecord(spec) ? spec : {};
  return {
    kind: "build",
    build: {
      rewards,
      speed: partFrom(specRecord, "speed", DEFAULT_SPEED),
      cost: partFrom(specRecord, "cost", DEFAULT_COST),
    },
  };
}
