import type { ModelTokenUsage } from "@/shared/types/api";

const MANAGED_GATEWAY_PREFIX = "litellm_proxy/";

/**
 * Strip the managed-gateway transport prefix off a model id. The reflection
 * model reports `litellm_proxy/<catalog id>` while the scorer ledger uses the
 * bare catalog id, so the same model would otherwise surface twice.
 */
export function canonicalModelId(model: string): string {
  return model.startsWith(MANAGED_GATEWAY_PREFIX)
    ? model.slice(MANAGED_GATEWAY_PREFIX.length)
    : model;
}

/**
 * Fold usage rows onto their canonical model id, summing tokens. Rows keep
 * the order their model was first seen in.
 */
export function mergeModelUsage(rows: readonly ModelTokenUsage[]): ModelTokenUsage[] {
  const merged = new Map<string, ModelTokenUsage>();
  for (const row of rows) {
    const model = canonicalModelId(row.model);
    const prior = merged.get(model);
    merged.set(model, {
      model,
      input_tokens: (prior?.input_tokens ?? 0) + row.input_tokens,
      output_tokens: (prior?.output_tokens ?? 0) + row.output_tokens,
    });
  }
  return [...merged.values()];
}
