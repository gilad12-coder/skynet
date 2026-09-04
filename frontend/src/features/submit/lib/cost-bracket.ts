/**
 * Projected credit bracket for a pre-run estimate.
 *
 * A DSPy/GEPA job's token use is not linear: bootstrapping, compile steps,
 * dataset size, and validation loops all swing the total, so a single tight
 * number would imply a precision the optimizer can't honour. Instead we project
 * a *bracket* — a low/high credit range — and let the user cap the run with a
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
  creditsForUsage,
  platformFeeCredits,
  type ModelTokenUsage,
  type TokenSourceMode,
} from "@/features/billing";

/** GEPA metric-call budgets by `auto` tier — mirrors the backend `_AUTO_BUDGETS`. */
const AUTO_METRIC_CALLS: Record<string, number> = {
  light: 500,
  medium: 2000,
  heavy: 8000,
};

/** Fallback metric-call budget when no `auto` tier and no explicit eval count is set. */
const DEFAULT_METRIC_CALLS = 2000;

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
  minimumSessionCredits: number | null;
  maximumSessionCredits: number | null;
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
    minimumSessionCredits: parse(profile.minimum_session_credits),
    maximumSessionCredits: parse(profile.maximum_session_credits),
    expectedSessions,
  };
}

export interface CostBracket {
  /** Low end of the projected credit range. */
  lowCredits: number;
  /** High end of the projected credit range. */
  highCredits: number;
  managedModelLowCredits: number;
  managedModelHighCredits: number;
  byokModelLowCredits: number;
  byokModelHighCredits: number;
  runtimeLowCredits: number;
  runtimeHighCredits: number;
  runtimeSessionLowCredits: number;
  runtimeSessionHighCredits: number;
  runtimeBillingBasis: RuntimeCostProjection["billingBasis"] | null;
  expectedRuntimeSessions: number;
}

/** Resolve the metric-call budget the bracket scales from. */
function resolveMetricCalls(
  autoLevel: string,
  maxFullEvals: string,
  maxMetricCalls?: string,
): number {
  const tier = autoLevel ? AUTO_METRIC_CALLS[autoLevel] : undefined;
  if (tier !== undefined) return tier;
  // An explicit metric-call budget is already the quantity this bracket
  // scales from — no conversion, and it outranks evals (mirrors build-kwargs).
  const calls = maxMetricCalls ? parseInt(maxMetricCalls, 10) : NaN;
  if (Number.isFinite(calls) && calls > 0) return calls;
  const evals = parseInt(maxFullEvals, 10);
  // max_full_evals counts full valset passes; a pass is on the order of a few
  // hundred calls, so scale it into the same metric-call space as the auto tiers.
  if (Number.isFinite(evals) && evals > 0) return evals * 250;
  return DEFAULT_METRIC_CALLS;
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
function runtimeCredits(runtime: RuntimeCostProjection | null | undefined): {
  low: number;
  high: number;
} {
  if (!runtime || runtime.billingBasis === "included_in_model_markup") return { low: 0, high: 0 };
  const sessions = Math.max(0, Math.floor(runtime.expectedSessions));
  const low = runtime.minimumSessionCredits;
  const high = runtime.maximumSessionCredits;
  return {
    low: low == null || !Number.isFinite(low) ? 0 : Math.ceil(Math.max(0, low) * sessions),
    high: high == null || !Number.isFinite(high) ? 0 : Math.ceil(Math.max(0, high) * sessions),
  };
}

/**
 * Project a low/high credit bracket for a run from its GEPA budget, dataset, and
 * chosen model(s).
 *
 * Returns rounded credit bounds; the high end seeds the default Max Cost Ceiling.
 * Always returns `highCredits >= lowCredits >= 1` so the bracket reads sensibly
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
  } = input;
  const calls = resolveMetricCalls(autoLevel, maxFullEvals, maxMetricCalls);
  // Larger datasets mean longer prompts and more baseline/eval rollouts; fold in
  // a gentle, sub-linear factor so a big dataset widens the bracket without
  // exploding it. Clamp the row factor so an empty/tiny dataset still projects.
  const rowFactor = 1 + Math.min(datasetRows, 2000) / 2000;
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
  const managedModelLowCredits = creditsForUsage(roleUsage(lowTokens, managed));
  const managedModelHighCredits = creditsForUsage(roleUsage(highTokens, managed));
  const byokModelLowCredits = creditsForUsage(roleUsage(lowTokens, byok));
  const byokModelHighCredits = creditsForUsage(roleUsage(highTokens, byok));
  const runtimeEstimate = runtimeCredits(runtime);
  const lowCredits = Math.max(
    1,
    managedModelLowCredits + byokModelLowCredits + runtimeEstimate.low,
  );
  const highCredits = Math.max(
    lowCredits,
    managedModelHighCredits + byokModelHighCredits + runtimeEstimate.high,
  );
  return {
    lowCredits,
    highCredits,
    managedModelLowCredits,
    managedModelHighCredits,
    byokModelLowCredits,
    byokModelHighCredits,
    runtimeLowCredits: runtimeEstimate.low,
    runtimeHighCredits: runtimeEstimate.high,
    runtimeSessionLowCredits: Math.max(0, runtime?.minimumSessionCredits ?? 0),
    runtimeSessionHighCredits: Math.max(0, runtime?.maximumSessionCredits ?? 0),
    runtimeBillingBasis: runtime?.billingBasis ?? null,
    expectedRuntimeSessions: runtime?.expectedSessions ?? 0,
  };
}

/**
 * The credit bracket the user is actually charged, given the token source.
 *
 * Managed roles are charged at full per-model cost; BYOK roles pay only
 * Skynet's platform fee because provider tokens use the user's key. At-cost
 * sandbox usage is added after that model calculation so it is never marked up
 * or discounted as a BYOK fee. Centralised so every estimate surface derives
 * the charge the same way and cannot drift apart.
 */
export function chargeableBracket(bracket: CostBracket, mode: TokenSourceMode): CostBracket {
  const hasRoleSources = bracket.managedModelLowCredits > 0 || bracket.byokModelLowCredits > 0;
  if (!hasRoleSources && mode !== "byok") return bracket;
  const managedLow = hasRoleSources ? bracket.managedModelLowCredits : 0;
  const managedHigh = hasRoleSources ? bracket.managedModelHighCredits : 0;
  const byokLow = hasRoleSources
    ? bracket.byokModelLowCredits
    : bracket.lowCredits - bracket.runtimeLowCredits;
  const byokHigh = hasRoleSources
    ? bracket.byokModelHighCredits
    : bracket.highCredits - bracket.runtimeHighCredits;
  const lowCredits = Math.max(
    1,
    managedLow + platformFeeCredits(byokLow) + bracket.runtimeLowCredits,
  );
  const highCredits = Math.max(
    lowCredits,
    managedHigh + platformFeeCredits(byokHigh) + bracket.runtimeHighCredits,
  );
  return { ...bracket, lowCredits, highCredits };
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
  const withHeadroom = Math.ceil(bracket.highCredits * 1.15);
  return roundToNiceCap(withHeadroom);
}

/** Round a credit cap up to a readable step (10s under 500, 50s above). */
function roundToNiceCap(credits: number): number {
  if (credits <= 0) return 1;
  const step = credits < 500 ? 10 : 50;
  return Math.ceil(credits / step) * step;
}
