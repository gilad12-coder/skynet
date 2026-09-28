/**
 * Projected cost bracket for a pre-run estimate.
 *
 * A DSPy/GEPA job's token use is not linear: bootstrapping, compile steps,
 * dataset size, and validation loops all swing the total, so a single tight
 * number would imply a precision the optimizer can't honour. Instead we project
 * a *bracket* — a low/high cost range — and let the user cap the run with a
 * Max Cost Ceiling. The numbers here are deliberately coarse and operator-tunable;
 * they exist to set expectations and seed a sensible default cap, never to promise
 * an exact charge.
 *
 * Anchored to GEPA's metric-call budgets (light/medium/heavy → 500/2000/8000
 * calls, mirroring the backend `_AUTO_BUDGETS`) times a per-call token estimate,
 * then priced *per-model* through the shared pricing engine so the chosen model's
 * real $/token moves the estimate — and the estimate reconciles with the
 * per-model charge. Pure and side-effect-free so it is trivially testable.
 */

import type { CatalogModel, ModelConfig, RuntimeCostProfile } from "@/shared/types/api";
import {
  DEFAULT_PRICING_TERMS,
  centsForUsage,
  modelTokenCosts,
  platformFeeCents,
  rawCostUsd,
  type ModelTokenUsage,
  type PricingTerms,
  type TokenSourceMode,
} from "@/features/billing";

/** GEPA metric-call budgets by `auto` tier — mirrors the backend `_AUTO_BUDGETS`. */
export const AUTO_METRIC_CALLS: Record<string, number> = {
  light: 500,
  medium: 2000,
  heavy: 8000,
};

/** Fallback metric-call budget when no `auto` tier and no explicit eval count is set. */
const DEFAULT_METRIC_CALLS = 2000;

/** Metric calls one full valset pass is taken to cost when scaling `max_full_evals`. */
const METRIC_CALLS_PER_FULL_EVAL = 250;

/** Dataset rows beyond which the row factor stops widening the bracket. */
const DATASET_ROW_CAP = 2000;

/**
 * Per-metric-call token estimate, low and high ends of the bracket. The spread
 * (≈6×) reflects how much one rollout's tokens vary with prompt/output length and
 * whether a reflection model is in the loop — the honest uncertainty the bracket
 * is meant to convey rather than hide.
 */
const TOKENS_PER_CALL_LOW = 700;
const TOKENS_PER_CALL_HIGH = 4500;

/** A reflection model adds a second LM pass per proposal — widen the high end. */
const REFLECTION_HIGH_MULTIPLIER = 1.5;

/** Share of a run's tokens spent on the reflection model's (fewer, larger) passes. */
const REFLECTION_TOKEN_SHARE = 0.35;

/** Per call, prompt + few-shot + dataset input dominates the shorter completion. */
const INPUT_TOKEN_SHARE = 0.7;

export interface CostBracketInput {
  /** GEPA `auto` tier ("light"/"medium"/"heavy"), or "" when an explicit eval count is used. */
  autoLevel: string;
  /** Explicit `max_full_evals` as a string from the wizard (used when `autoLevel` is empty). */
  maxFullEvals: string;
  /** Explicit `max_metric_calls` budget — already in metric-call space, so it wins over evals. */
  maxMetricCalls?: string;
  /** Dataset row count — scales the per-eval work; 0 when no dataset is loaded yet. */
  datasetRows: number;
  /** For a grid search, the number of (gen × refl) model pairs swept; 1 for a single run. */
  pairs?: number;
  /** The task (generation) model, used to price the projected tokens per-model. */
  taskModel?: CatalogModel | null;
  /** The reflection model when configured; its presence both prices and widens the bracket. */
  reflectionModel?: CatalogModel | null;
  /** Explicit physical model roles. Reused model selections remain separate calls. */
  modelRoles?: ProjectedModelRole[];
  /** Incremental runtime cost for the selected isolated execution environment. */
  runtime?: RuntimeCostProjection | null;
  /** The backend's markup and BYOK fee; the seed defaults until the wallet loads. */
  pricing?: Pick<PricingTerms, "usageMarkup" | "byokFeeFraction">;
}

export interface ProjectedModelRole {
  role: "task" | "optimization" | "judge";
  model: CatalogModel | null;
  tokenSource: TokenSourceMode;
  /** Fraction or multiple of the base per-evaluation token projection used by this role. */
  tokenShare: number;
}

export interface RuntimeCostProjection {
  billingBasis: "at_cost" | "included_in_model_markup";
  minimumSessionCents: number | null;
  maximumSessionCents: number | null;
  /** Distinct paid preflight scopes on this path plus its submitted run. */
  expectedSessions: number;
}

/** Convert the server's authoritative runtime rates without treating missing prices as free. */
export function runtimeCostProjection(
  profile: RuntimeCostProfile | null | undefined,
  expectedSessions: number,
): RuntimeCostProjection | null {
  if (!profile) return null;
  const parse = (value: string | null): number | null => {
    if (value == null) return null;
    const amount = Number(value);
    return Number.isFinite(amount) && amount >= 0 ? amount : null;
  };
  return {
    billingBasis: profile.billing_basis,
    minimumSessionCents: parse(profile.minimum_session_cents),
    maximumSessionCents: parse(profile.maximum_session_cents),
    expectedSessions,
  };
}

/** Where the metric-call budget the bracket scales from came from. */
export type MetricCallSource = "auto_tier" | "metric_calls" | "full_evals" | "default";

/** One priced model role, with the raw provider cost its projected tokens carry. */
export interface RoleCostTrace {
  role: ProjectedModelRole["role"];
  modelLabel: string | null;
  tokenSource: TokenSourceMode;
  tokenShare: number;
  inputCostPerToken: number;
  outputCostPerToken: number;
  /** False when the catalog left the model unpriced and the default rates apply. */
  priced: boolean;
  lowUsd: number;
  highUsd: number;
}

/**
 * Every input and intermediate value behind a bracket, so a surface can unfold
 * the arithmetic instead of restating it. Built by the same pass that produces
 * the cent totals, which keeps the two from drifting apart.
 */
export interface CostBracketTrace {
  metricCalls: number;
  metricCallSource: MetricCallSource;
  autoLevel: string;
  fullEvals: number;
  metricCallsPerFullEval: number;
  datasetRows: number;
  datasetRowCap: number;
  rowFactor: number;
  tokensPerCallLow: number;
  tokensPerCallHigh: number;
  /** 1 without an optimization role; the reflection multiplier with one. */
  reflectionHighMultiplier: number;
  lowTokens: number;
  highTokens: number;
  inputTokenShare: number;
  roles: RoleCostTrace[];
}

export interface CostBracket {
  /** Low end of the projected cost range, in cents. */
  lowCents: number;
  /** High end of the projected cost range, in cents. */
  highCents: number;
  /** Managed-role model cents, including the usage markup. */
  managedModelLowCents: number;
  managedModelHighCents: number;
  /** BYOK-role model cents at cost (no markup) — the base the BYOK fee is taken from. */
  byokModelLowCents: number;
  byokModelHighCents: number;
  /** The usage markup applied to the managed cents. */
  usageMarkup: number;
  /** The BYOK platform fee fraction `chargeableBracket` applies. */
  byokFeeFraction: number;
  runtimeLowCents: number;
  runtimeHighCents: number;
  runtimeSessionLowCents: number;
  runtimeSessionHighCents: number;
  runtimeBillingBasis: RuntimeCostProjection["billingBasis"] | null;
  expectedRuntimeSessions: number;
  trace: CostBracketTrace;
}

/** How a charged bracket splits between full-price usage, BYOK fees and runtime. */
export interface ChargeTrace {
  mode: TokenSourceMode;
  managedLow: number;
  managedHigh: number;
  byokFullLow: number;
  byokFullHigh: number;
  byokFeeLow: number;
  byokFeeHigh: number;
  runtimeLow: number;
  runtimeHigh: number;
}

export interface ChargedBracket extends CostBracket {
  charge: ChargeTrace;
}

/** Resolve the metric-call budget the bracket scales from, and where it came from. */
function resolveMetricCalls(
  autoLevel: string,
  maxFullEvals: string,
  maxMetricCalls?: string,
): { calls: number; source: MetricCallSource; evals: number } {
  const tier = autoLevel ? AUTO_METRIC_CALLS[autoLevel] : undefined;
  if (tier !== undefined) return { calls: tier, source: "auto_tier", evals: 0 };
  // An explicit metric-call budget is already the quantity this bracket
  // scales from — no conversion, and it outranks evals (mirrors build-kwargs).
  const calls = maxMetricCalls ? parseInt(maxMetricCalls, 10) : NaN;
  if (Number.isFinite(calls) && calls > 0) return { calls, source: "metric_calls", evals: 0 };
  const evals = parseInt(maxFullEvals, 10);
  // max_full_evals counts full valset passes; a pass is on the order of a few
  // hundred calls, so scale it into the same metric-call space as the auto tiers.
  if (Number.isFinite(evals) && evals > 0)
    return { calls: evals * METRIC_CALLS_PER_FULL_EVAL, source: "full_evals", evals };
  return { calls: DEFAULT_METRIC_CALLS, source: "default", evals: 0 };
}

/** Price explicit roles without collapsing two calls that happen to use the same model. */
function roleUsage(totalTokens: number, roles: ProjectedModelRole[]): ModelTokenUsage[] {
  return roles
    .filter((role) => Number.isFinite(role.tokenShare) && role.tokenShare > 0)
    .map((role) => ({
      model: role.model,
      inputTokens: totalTokens * role.tokenShare * INPUT_TOKEN_SHARE,
      outputTokens: totalTokens * role.tokenShare * (1 - INPUT_TOKEN_SHARE),
    }));
}

/** Convert current runtime metadata into one setup-plus-run estimate category. */
function runtimeCents(runtime: RuntimeCostProjection | null | undefined): {
  low: number;
  high: number;
} {
  if (!runtime || runtime.billingBasis === "included_in_model_markup") return { low: 0, high: 0 };
  const sessions = Math.max(0, Math.floor(runtime.expectedSessions));
  const low = runtime.minimumSessionCents;
  const high = runtime.maximumSessionCents;
  const perSessionHigh = high == null || !Number.isFinite(high) ? 0 : Math.max(0, high);
  // A box reserves its whole lifetime the moment it opens, so the low end
  // starts at one full session's hold however briefly the sessions run.
  const hold = sessions > 0 ? Math.ceil(perSessionHigh) : 0;
  return {
    low: Math.max(
      hold,
      low == null || !Number.isFinite(low) ? 0 : Math.ceil(Math.max(0, low) * sessions),
    ),
    high: Math.ceil(perSessionHigh * sessions),
  };
}

/**
 * Project a low/high cost bracket for a run from its GEPA budget, dataset, and
 * chosen model(s).
 *
 * Returns rounded cent bounds; the high end seeds the default Max Cost Ceiling.
 * Always returns `highCents >= lowCents >= 1` so the bracket reads sensibly
 * even before a dataset or catalog has loaded (models price at defaults until then).
 */
export function projectCostBracket(input: CostBracketInput): CostBracket {
  const {
    autoLevel,
    maxFullEvals,
    maxMetricCalls,
    datasetRows,
    pairs = 1,
    taskModel = null,
    reflectionModel = null,
    modelRoles,
    runtime,
    pricing = DEFAULT_PRICING_TERMS,
  } = input;
  const budget = resolveMetricCalls(autoLevel, maxFullEvals, maxMetricCalls);
  const calls = budget.calls;
  // Larger datasets mean longer prompts and more baseline/eval rollouts; fold in
  // a gentle, sub-linear factor so a big dataset widens the bracket without
  // exploding it. Clamp the row factor so an empty/tiny dataset still projects.
  const rowFactor = 1 + Math.min(datasetRows, DATASET_ROW_CAP) / DATASET_ROW_CAP;
  const sweep = Math.max(pairs, 1);
  const roles =
    modelRoles && modelRoles.length > 0
      ? modelRoles
      : [
          {
            role: "task" as const,
            model: taskModel,
            tokenSource: "managed" as const,
            tokenShare: reflectionModel ? (1 - REFLECTION_TOKEN_SHARE) * sweep : sweep,
          },
          ...(reflectionModel
            ? [
                {
                  role: "optimization" as const,
                  model: reflectionModel,
                  tokenSource: "managed" as const,
                  tokenShare: REFLECTION_TOKEN_SHARE * sweep,
                },
              ]
            : []),
        ];
  const hasReflection = roles.some((role) => role.role === "optimization");

  const lowTokens = calls * TOKENS_PER_CALL_LOW * rowFactor;
  const highTokens =
    calls * TOKENS_PER_CALL_HIGH * rowFactor * (hasReflection ? REFLECTION_HIGH_MULTIPLIER : 1);
  const managed = roles.filter((role) => role.tokenSource !== "byok");
  const byok = roles.filter((role) => role.tokenSource === "byok");
  const { usageMarkup, byokFeeFraction } = pricing;
  const managedModelLowCents = centsForUsage(roleUsage(lowTokens, managed), usageMarkup);
  const managedModelHighCents = centsForUsage(roleUsage(highTokens, managed), usageMarkup);
  const byokModelLowCents = centsForUsage(roleUsage(lowTokens, byok), 1);
  const byokModelHighCents = centsForUsage(roleUsage(highTokens, byok), 1);
  const runtimeEstimate = runtimeCents(runtime);
  const lowCents = Math.max(1, managedModelLowCents + byokModelLowCents + runtimeEstimate.low);
  const highCents = Math.max(
    lowCents,
    managedModelHighCents + byokModelHighCents + runtimeEstimate.high,
  );
  const tracedRoles: RoleCostTrace[] = roles
    .filter((role) => Number.isFinite(role.tokenShare) && role.tokenShare > 0)
    .map((role) => {
      const costs = modelTokenCosts(role.model);
      const [lowUsage] = roleUsage(lowTokens, [role]);
      const [highUsage] = roleUsage(highTokens, [role]);
      return {
        role: role.role,
        modelLabel: role.model?.label ?? null,
        tokenSource: role.tokenSource,
        tokenShare: role.tokenShare,
        inputCostPerToken: costs.input,
        outputCostPerToken: costs.output,
        priced:
          typeof role.model?.input_cost_per_token === "number" &&
          role.model.input_cost_per_token > 0 &&
          typeof role.model?.output_cost_per_token === "number" &&
          role.model.output_cost_per_token > 0,
        lowUsd: lowUsage ? rawCostUsd([lowUsage]) : 0,
        highUsd: highUsage ? rawCostUsd([highUsage]) : 0,
      };
    });
  return {
    lowCents,
    highCents,
    managedModelLowCents,
    managedModelHighCents,
    byokModelLowCents,
    byokModelHighCents,
    usageMarkup,
    byokFeeFraction,
    runtimeLowCents: runtimeEstimate.low,
    runtimeHighCents: runtimeEstimate.high,
    runtimeSessionLowCents: Math.max(0, runtime?.minimumSessionCents ?? 0),
    runtimeSessionHighCents: Math.max(0, runtime?.maximumSessionCents ?? 0),
    runtimeBillingBasis: runtime?.billingBasis ?? null,
    expectedRuntimeSessions: runtime?.expectedSessions ?? 0,
    trace: {
      metricCalls: calls,
      metricCallSource: budget.source,
      autoLevel,
      fullEvals: budget.evals,
      metricCallsPerFullEval: METRIC_CALLS_PER_FULL_EVAL,
      datasetRows,
      datasetRowCap: DATASET_ROW_CAP,
      rowFactor,
      tokensPerCallLow: TOKENS_PER_CALL_LOW,
      tokensPerCallHigh: TOKENS_PER_CALL_HIGH,
      reflectionHighMultiplier: hasReflection ? REFLECTION_HIGH_MULTIPLIER : 1,
      lowTokens,
      highTokens,
      inputTokenShare: INPUT_TOKEN_SHARE,
      roles: tracedRoles,
    },
  };
}

/**
 * The cost bracket the user is actually charged, given the token source.
 *
 * Managed roles are charged at full per-model cost; BYOK roles pay only
 * Skynet's platform fee because provider tokens use the user's key. Sandbox
 * usage (already marked up by the backend quote) is added after that model
 * calculation so it is never discounted as a BYOK fee. Centralised so every estimate surface derives
 * the charge the same way and cannot drift apart.
 */
export function chargeableBracket(bracket: CostBracket, mode: TokenSourceMode): ChargedBracket {
  const hasRoleSources = bracket.managedModelLowCents > 0 || bracket.byokModelLowCents > 0;
  if (!hasRoleSources && mode !== "byok") {
    return {
      ...bracket,
      charge: {
        mode,
        managedLow: bracket.lowCents - bracket.runtimeLowCents,
        managedHigh: bracket.highCents - bracket.runtimeHighCents,
        byokFullLow: 0,
        byokFullHigh: 0,
        byokFeeLow: 0,
        byokFeeHigh: 0,
        runtimeLow: bracket.runtimeLowCents,
        runtimeHigh: bracket.runtimeHighCents,
      },
    };
  }
  const managedLow = hasRoleSources ? bracket.managedModelLowCents : 0;
  const managedHigh = hasRoleSources ? bracket.managedModelHighCents : 0;
  const byokLow = hasRoleSources
    ? bracket.byokModelLowCents
    : bracket.lowCents - bracket.runtimeLowCents;
  const byokHigh = hasRoleSources
    ? bracket.byokModelHighCents
    : bracket.highCents - bracket.runtimeHighCents;
  const byokFeeLow = platformFeeCents(byokLow, bracket.byokFeeFraction);
  const byokFeeHigh = platformFeeCents(byokHigh, bracket.byokFeeFraction);
  const lowCents = Math.max(1, managedLow + byokFeeLow + bracket.runtimeLowCents);
  const highCents = Math.max(lowCents, managedHigh + byokFeeHigh + bracket.runtimeHighCents);
  return {
    ...bracket,
    lowCents,
    highCents,
    charge: {
      mode,
      managedLow,
      managedHigh,
      byokFullLow: byokLow,
      byokFullHigh: byokHigh,
      byokFeeLow,
      byokFeeHigh,
      runtimeLow: bracket.runtimeLowCents,
      runtimeHigh: bracket.runtimeHighCents,
    },
  };
}

/**
 * Cents the run's execution environment holds the moment it starts: the
 * cost of its whole lifetime, released as the run settles. A spending limit
 * below this cannot start the run at all, however small the usage estimate.
 */
export function runtimeStartHold(bracket: CostBracket): number {
  return bracket.runtimeBillingBasis === "at_cost" ? Math.ceil(bracket.runtimeSessionHighCents) : 0;
}

/** Collapse per-model sources to the conservative job-level billing stamp. */
export function aggregateTokenSource(configs: ModelConfig[]): TokenSourceMode {
  const selected = configs.filter((config) => config.name.trim());
  return selected.length > 0 && selected.every((config) => config.token_source === "byok")
    ? "byok"
    : "managed";
}

/**
 * Default Max Cost Ceiling for a freshly-projected bracket: the high end with a
 * little headroom, rounded to a friendly figure. Headroom keeps the cap from
 * tripping on an ordinary run that lands near the top of the bracket while still
 * bounding a runaway.
 */
export function defaultCeilingForBracket(bracket: CostBracket): number {
  return defaultCeilingTrace(bracket).ceilingCents;
}

/** Headroom applied to the bracket's high end before rounding it into a cap. */
const CEILING_HEADROOM_FACTOR = 1.15;

/** The steps from a bracket's high end to its default cap, for surfaces that show the working. */
export interface CeilingTrace {
  highCents: number;
  headroomFactor: number;
  withHeadroomCents: number;
  /** The rounding step the cap was lifted to (10 cents under 500, 50 above). */
  stepCents: number;
  ceilingCents: number;
}

/** Derive the default cap and every intermediate value behind it. */
export function defaultCeilingTrace(bracket: CostBracket): CeilingTrace {
  const withHeadroom = Math.ceil(bracket.highCents * CEILING_HEADROOM_FACTOR);
  const stepCents = niceCapStep(withHeadroom);
  return {
    highCents: bracket.highCents,
    headroomFactor: CEILING_HEADROOM_FACTOR,
    withHeadroomCents: withHeadroom,
    stepCents,
    ceilingCents: roundToNiceCap(withHeadroom),
  };
}

/** The readable step a cap is rounded up to: 10s under 500 cents, 50s above. */
function niceCapStep(cents: number): number {
  return cents < 500 ? 10 : 50;
}

/** Round a cent cap up to a readable step (10s under 500, 50s above). */
function roundToNiceCap(cents: number): number {
  if (cents <= 0) return 1;
  const step = niceCapStep(cents);
  return Math.ceil(cents / step) * step;
}
