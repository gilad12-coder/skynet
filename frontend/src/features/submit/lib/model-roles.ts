import type { BlackboxEngineId, ModelConfig } from "@/shared/types/api";
import type { MessageKey } from "@/shared/lib/generated/ui-catalog";

/**
 * Model roles of the Anything wizard: the scoring model either inherits the
 * optimization model or carries its own configuration. Inheritance is a
 * relationship, not a copy — the inherited binding follows every change to
 * the optimization selection until the user breaks it.
 */
export type ScoringModelMode = "inherit" | "explicit";

/** The engine families whose proposer the optimization model drives. */
export type OptimizationModelFamily = "gepa" | "meta_harness" | "autoresearch";

/**
 * Credential-free identity of a model configuration. Two configs with the
 * same name but different sampling settings are different models here;
 * keys and transport endpoints never decide what a model answers.
 */
export function modelIdentity(config: ModelConfig | null | undefined): string | null {
  if (!config) return null;
  const name = config.name.trim();
  if (!name) return null;
  const { api_key: _apiKey, api_base: _apiBase, base_url: _baseUrl, ...extra } = config.extra ?? {};
  const tokenSource = config.token_source ?? "managed";
  const extraEntries = Object.entries(extra).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify({
    name,
    token_source: tokenSource,
    byok_provider: tokenSource === "byok" ? (config.byok_provider ?? null) : null,
    temperature: config.temperature ?? null,
    max_tokens: config.max_tokens ?? null,
    extra: extraEntries.length > 0 ? Object.fromEntries(extraEntries) : null,
  });
}

export function sameModelConfig(
  a: ModelConfig | null | undefined,
  b: ModelConfig | null | undefined,
): boolean {
  return modelIdentity(a) === modelIdentity(b);
}

export interface ScoringBinding {
  mode: ScoringModelMode;
  /** The configuration scoring calls will use; null while nothing resolves yet. */
  resolved: ModelConfig | null;
  /** Inherited from an optimization model that has not been chosen yet. */
  pending: boolean;
}

/** Resolve the scoring model, or null when the evaluator never invokes one. */
export function resolveScoringModel(input: {
  usesModel: boolean;
  mode: ScoringModelMode;
  explicit: ModelConfig;
  optimization: ModelConfig;
}): ScoringBinding | null {
  if (!input.usesModel) return null;
  if (input.mode === "explicit") {
    return {
      mode: "explicit",
      resolved: input.explicit.name.trim() ? input.explicit : null,
      pending: false,
    };
  }
  const inherited = input.optimization.name.trim() ? input.optimization : null;
  return { mode: "inherit", resolved: inherited, pending: inherited == null };
}

/** Which proposer the optimization model drives for the chosen strategy. */
export function optimizationModelFamily(
  strategyMode: "auto" | "single" | "plateau",
  engine: BlackboxEngineId | null,
): OptimizationModelFamily {
  if (strategyMode === "single") {
    if (engine === "meta_harness") return "meta_harness";
    if (engine === "autoresearch") return "autoresearch";
  }
  return "gepa";
}

export const OPTIMIZATION_MODEL_DESCRIPTION: Readonly<Record<OptimizationModelFamily, MessageKey>> =
  {
    gepa: "submit.blackbox.roles.optimization.desc.gepa",
    meta_harness: "submit.blackbox.roles.optimization.desc.meta_harness",
    autoresearch: "submit.blackbox.roles.optimization.desc.autoresearch",
  };
