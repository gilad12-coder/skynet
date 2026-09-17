/**
 * Per-model credit pricing — the frontend mirror of backend `core.billing.pricing`.
 *
 * A run's credit cost is the real provider cost of its tokens (per-model
 * input/output rates from the catalog), converted to credits at
 * `CREDIT_USD_VALUE` — one credit per cent, at par with the dollar. Runs bill at
 * true provider cost (`MARKUP` is `1.0`); the platform earns on the
 * credit-purchase fee, OpenRouter-style, not a per-token markup. The same
 * function prices a *projected* token volume here (the pre-run estimate) that the
 * backend prices on *measured* tokens (the charge), so the estimate and the bill
 * reconcile by construction.
 *
 * Keep `MARKUP`, `PLATFORM_FEE_FRACTION`, and the default rates in step with the
 * backend module — they must not drift between the estimate and the charge.
 */

import type { CatalogModel } from "@/shared/types/api";
import { CREDIT_USD_VALUE } from "./credit";

/** Multiplier on raw provider cost — mirrors backend `pricing.MARKUP`. Runs are
 * sold at true provider cost, so this is `1.0` (a no-op); the platform's margin
 * comes from the credit-purchase fee, not a per-token markup. Kept as a lever so
 * a per-run margin could be reintroduced in one place. */
export const MARKUP = 1.0;

/** Fallback per-token costs (USD) for a model the catalog doesn't price. */
export const DEFAULT_INPUT_COST_PER_TOKEN = 1e-6;
export const DEFAULT_OUTPUT_COST_PER_TOKEN = 3e-6;

/** The platform fee charged on a BYOK run — a share of the equivalent model
 * cost, mirroring backend `PLATFORM_FEE_FRACTION` and OpenRouter's 5% BYOK fee.
 * The provider tokens are on the user's own key, so this is all a BYOK run
 * spends. */
export const PLATFORM_FEE_FRACTION = 0.05;

/** Projected or measured token usage attributed to one model. */
export interface ModelTokenUsage {
  /** The model the tokens ran on; `null`/`undefined` prices at the defaults. */
  model?: CatalogModel | null;
  inputTokens: number;
  outputTokens: number;
}

/**
 * A model's `(input, output)` per-token cost in USD, falling back to the module
 * defaults when the catalog leaves a rate unpriced (so a model is never free).
 */
export function modelTokenCosts(model?: CatalogModel | null): { input: number; output: number } {
  const input = model?.input_cost_per_token;
  const output = model?.output_cost_per_token;
  return {
    input: typeof input === "number" && input > 0 ? input : DEFAULT_INPUT_COST_PER_TOKEN,
    output: typeof output === "number" && output > 0 ? output : DEFAULT_OUTPUT_COST_PER_TOKEN,
  };
}

/** Raw provider cost (USD, pre-markup) of per-model token usage. */
export function rawCostUsd(usages: ModelTokenUsage[]): number {
  let total = 0;
  for (const usage of usages) {
    const { input, output } = modelTokenCosts(usage.model);
    total += usage.inputTokens * input + usage.outputTokens * output;
  }
  return total;
}

/**
 * Convert per-model token usage to the credits it costs, rounding up. Mirrors
 * backend `credits_for_usage`: any non-zero usage costs at least one credit.
 */
export function creditsForUsage(usages: ModelTokenUsage[]): number {
  const cost = rawCostUsd(usages) * MARKUP;
  if (cost <= 0) return 0;
  return Math.max(1, Math.ceil(cost / CREDIT_USD_VALUE));
}

/**
 * The BYOK platform fee for a run's full credit cost, rounding up — mirrors
 * backend `platform_fee_credits_for_usage`. On a BYOK run the provider tokens are
 * paid on the user's own key, so only this fraction is charged in credits.
 */
export function platformFeeCredits(fullCredits: number): number {
  const fee = fullCredits * PLATFORM_FEE_FRACTION;
  if (fee <= 0) return 0;
  return Math.max(1, Math.ceil(fee));
}
