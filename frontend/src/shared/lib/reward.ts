/**
 * The accuracy, speed and cost reward (SKY-69), read from the metric's code.
 *
 * The metric declares `REWARD_SPEC` as plain Python data and returns
 * `reward(REWARD_SPEC, accuracy, feedback)`; the run's harness applies it with
 * the trusted time and cost of each response. This module reads the same spec
 * and applies the same formula (`blend_reward` in
 * `backend/.../workspace_harness.py`), so the setup preview and the results
 * show exactly what the run scores. No imports: `node --test` loads it as is.
 */

export type RewardComponent = "accuracy" | "speed" | "cost";

export const REWARD_COMPONENTS: readonly RewardComponent[] = ["accuracy", "speed", "cost"];

export interface RewardComponentSpec {
  meaning: string;
  unit: string;
  /** The value that scores half; `null` for an accuracy given as a 0-1 score. */
  reference: number | null;
}

export interface RewardSpec {
  /** Normalized to sum to 1. */
  weights: Record<RewardComponent, number>;
  accuracy: RewardComponentSpec;
  speed: RewardComponentSpec & { reference: number };
  cost: RewardComponentSpec & { reference: number };
}

export type RewardSpecRead =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "spec"; spec: RewardSpec };

/** One response's raw measurements; `null` means not measured or no usable answer. */
export interface RewardInputs {
  accuracy: number | null;
  timeMs: number | null;
  costUsd: number | null;
}

export interface RewardScore {
  total: number;
  components: Record<RewardComponent, number>;
  contributions: Record<RewardComponent, number>;
  unavailable: RewardComponent[];
}

type PyValue = string | number | boolean | null | PyValue[] | { [key: string]: PyValue };

/** Parse one Python literal (dict, list, str, number, bool, None) from `text` at `start`. */
function parsePyLiteral(text: string, start: number): { value: PyValue; end: number } | null {
  let i = start;
  const skip = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i]!)) i++;
      if (text[i] !== "#") return;
      while (i < text.length && text[i] !== "\n") i++;
    }
  };
  const value = (): PyValue | undefined => {
    skip();
    const ch = text[i];
    if (ch === "{" || ch === "[") {
      const close = ch === "{" ? "}" : "]";
      i++;
      const dict: Record<string, PyValue> = {};
      const list: PyValue[] = [];
      for (;;) {
        skip();
        if (text[i] === close) {
          i++;
          return ch === "{" ? dict : list;
        }
        const item = value();
        if (item === undefined) return undefined;
        skip();
        if (ch === "{") {
          if (typeof item !== "string" || text[i] !== ":") return undefined;
          i++;
          const entry = value();
          if (entry === undefined) return undefined;
          dict[item] = entry;
          skip();
        } else {
          list.push(item);
        }
        if (text[i] === ",") i++;
        else if (text[i] !== close) return undefined;
      }
    }
    if (ch === '"' || ch === "'") {
      let out = "";
      // Adjacent literals concatenate, as in Python.
      while (text[i] === '"' || text[i] === "'") {
        const quote = text[i];
        i++;
        while (i < text.length && text[i] !== quote) {
          if (text[i] === "\n") return undefined;
          if (text[i] === "\\" && i + 1 < text.length) i++;
          out += text[i];
          i++;
        }
        if (text[i] !== quote) return undefined;
        i++;
        skip();
      }
      return out;
    }
    const word = /^(?:True|False|None|[-+]?(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][-+]?\d+)?)/.exec(
      text.slice(i),
    );
    if (!word) return undefined;
    i += word[0].length;
    if (word[0] === "True") return true;
    if (word[0] === "False") return false;
    if (word[0] === "None") return null;
    const number = Number(word[0].replace(/_/g, ""));
    return Number.isFinite(number) ? number : undefined;
  };
  const parsed = value();
  return parsed === undefined ? null : { value: parsed, end: i };
}

function isRecord(value: unknown): value is Record<string, PyValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positive(value: unknown): number | null {
  return typeof value === "number" && value > 0 && Number.isFinite(value) ? value : null;
}

/** Validate a raw spec the way the harness's `reward_spec` does; `null` when it would refuse it. */
export function rewardSpecFrom(raw: unknown): RewardSpec | null {
  if (!isRecord(raw) || !isRecord(raw.weights)) return null;
  const weights = {} as Record<RewardComponent, number>;
  for (const name of REWARD_COMPONENTS) {
    const weight = raw.weights[name];
    if (typeof weight !== "number" || !(weight >= 0)) return null;
    weights[name] = weight;
  }
  const total = weights.accuracy + weights.speed + weights.cost;
  if (!(total > 0)) return null;
  const component = (name: RewardComponent): RewardComponentSpec | null => {
    const entry = raw[name] ?? {};
    if (!isRecord(entry)) return null;
    const reference = entry.reference ?? null;
    const checked = reference === null ? null : positive(reference);
    if (reference !== null && checked === null) return null;
    return {
      meaning: typeof entry.meaning === "string" ? entry.meaning : "",
      unit: typeof entry.unit === "string" ? entry.unit : "",
      reference: checked,
    };
  };
  const accuracy = component("accuracy");
  const speed = component("speed");
  const cost = component("cost");
  if (!accuracy || speed?.reference == null || cost?.reference == null) return null;
  return {
    weights: {
      accuracy: weights.accuracy / total,
      speed: weights.speed / total,
      cost: weights.cost / total,
    },
    accuracy,
    speed: { ...speed, reference: speed.reference },
    cost: { ...cost, reference: cost.reference },
  };
}

/**
 * Read the metric's module-level `REWARD_SPEC = {...}`.
 *
 * Returns `none` when the metric declares no spec, and `invalid` when it does
 * but the value is not plain literal data the harness would accept.
 */
export function readRewardSpec(metricCode: string | null | undefined): RewardSpecRead {
  const match = /^REWARD_SPEC\s*(?::[^=\n]*)?=\s*/m.exec(metricCode ?? "");
  if (!match || metricCode == null) return { kind: "none" };
  const parsed = parsePyLiteral(metricCode, match.index + match[0].length);
  const spec = parsed ? rewardSpecFrom(parsed.value) : null;
  return spec ? { kind: "spec", spec } : { kind: "invalid" };
}

/** `reference / (reference + value)`: 1 at 0, ½ at the reference, falling everywhere. */
export function referenceUtility(value: number, reference: number): number {
  return reference / (reference + Math.max(value, 0));
}

/** Score one response the way the harness's `blend_reward` does. */
export function scoreReward(spec: RewardSpec, inputs: RewardInputs): RewardScore {
  const unavailable: RewardComponent[] = [];
  const components = { accuracy: 0, speed: 0, cost: 0 };
  if (inputs.accuracy == null || !Number.isFinite(inputs.accuracy)) unavailable.push("accuracy");
  else
    components.accuracy =
      spec.accuracy.reference != null
        ? referenceUtility(inputs.accuracy, spec.accuracy.reference)
        : Math.min(Math.max(inputs.accuracy, 0), 1);
  if (inputs.timeMs == null) unavailable.push("speed");
  else components.speed = referenceUtility(inputs.timeMs, spec.speed.reference);
  if (inputs.costUsd == null) unavailable.push("cost");
  else components.cost = referenceUtility(inputs.costUsd, spec.cost.reference);
  const contributions = {
    accuracy: spec.weights.accuracy * components.accuracy,
    speed: spec.weights.speed * components.speed,
    cost: spec.weights.cost * components.cost,
  };
  return {
    total: contributions.accuracy + contributions.speed + contributions.cost,
    components,
    contributions,
    unavailable,
  };
}

export type PreviewCaseKind =
  | "reference"
  | "better_accuracy"
  | "faster"
  | "cheaper"
  | "tradeoff"
  | "empty"
  | "wrong"
  | "no_cost";

export interface PreviewCase {
  kind: PreviewCaseKind;
  /** For a one-change pair: the worse and the better value of that component. */
  change?: { component: RewardComponent; from: number; to: number };
  inputs: RewardInputs;
  /** For a one-change pair: the response before the change. */
  before?: RewardInputs;
}

/**
 * The controlled cases the setup review shows (SKY-69 criteria 1 to 3).
 *
 * Each "better" pair changes one component and keeps the others at their
 * reference, once above and once below the reference. The rest show a
 * tradeoff, an empty and a wrong but fast, cheap response, and an unpriced
 * call. Accuracy without a reference is a 0-1 score, so higher is better.
 */
export function rewardPreviewCases(spec: RewardSpec): PreviewCase[] {
  const accRef = spec.accuracy.reference;
  const scoreAccuracy = accRef == null;
  const base: RewardInputs = {
    accuracy: scoreAccuracy ? 0.5 : accRef,
    timeMs: spec.speed.reference,
    costUsd: spec.cost.reference,
  };
  const pair = (
    kind: PreviewCaseKind,
    component: RewardComponent,
    from: number,
    to: number,
  ): PreviewCase => {
    const key =
      component === "accuracy" ? "accuracy" : component === "speed" ? "timeMs" : "costUsd";
    return {
      kind,
      change: { component, from, to },
      before: { ...base, [key]: from },
      inputs: { ...base, [key]: to },
    };
  };
  const accuracyPairs: PreviewCase[] = scoreAccuracy
    ? [pair("better_accuracy", "accuracy", 0.2, 0.4), pair("better_accuracy", "accuracy", 0.7, 0.9)]
    : [
        pair("better_accuracy", "accuracy", accRef * 2, accRef * 1.5),
        pair("better_accuracy", "accuracy", accRef * 0.5, accRef * 0.1),
      ];
  const speedRef = spec.speed.reference;
  const costRef = spec.cost.reference;
  return [
    { kind: "reference", inputs: base },
    ...accuracyPairs,
    pair("faster", "speed", speedRef * 3, speedRef * 1.5),
    pair("faster", "speed", speedRef * 0.5, speedRef * 0.15),
    pair("cheaper", "cost", costRef * 4, costRef * 2),
    pair("cheaper", "cost", costRef * 0.5, costRef * 0.1),
    {
      kind: "tradeoff",
      inputs: {
        accuracy: scoreAccuracy ? 0.95 : accRef * 0.04,
        timeMs: speedRef * 1.25,
        costUsd: costRef * 1.2,
      },
    },
    { kind: "empty", inputs: { accuracy: null, timeMs: speedRef * 0.05, costUsd: 0 } },
    {
      kind: "wrong",
      inputs: {
        accuracy: scoreAccuracy ? 0 : accRef * 20,
        timeMs: speedRef * 0.1,
        costUsd: costRef * 0.1,
      },
    },
    { kind: "no_cost", inputs: { ...base, costUsd: null } },
  ];
}

/** The part of a case observation (SKY-68) the reward reads. */
export interface ResponseObservation {
  timing?: { task_ms?: number | null } | null;
  cost?: { usd?: number | null; status?: string | null; reason?: string | null } | null;
}

export interface ObservationSummary {
  /** Responses with a measured time / a priced cost. */
  timed: number;
  priced: number;
  /** Responses with an observation but no price. */
  unpriced: number;
  meanMs: number | null;
  p95Ms: number | null;
  meanCostUsd: number | null;
}

/** Nearest-rank percentile of `values` (already measured, any order). */
export function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)] ?? null;
}

/** Mean and p95 time and mean cost per response, from each response's own observation. */
export function summarizeObservations(
  observations: Array<ResponseObservation | null | undefined>,
): ObservationSummary {
  const times: number[] = [];
  const costs: number[] = [];
  let unpriced = 0;
  for (const observation of observations) {
    if (!observation) continue;
    const ms = observation.timing?.task_ms;
    if (typeof ms === "number" && Number.isFinite(ms)) times.push(ms);
    const usd = observation.cost?.usd;
    if (typeof usd === "number" && Number.isFinite(usd)) costs.push(usd);
    else unpriced++;
  }
  const mean = (values: number[]) =>
    values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
  return {
    timed: times.length,
    priced: costs.length,
    unpriced,
    meanMs: mean(times),
    p95Ms: percentile(times, 0.95),
    meanCostUsd: mean(costs),
  };
}
