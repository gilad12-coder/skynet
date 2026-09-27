import { msg } from "@/shared/lib/messages";

// Effort vocabularies are per-API, not universal, and providers silently
// clamp or reject levels outside their documented ladder. The catalog
// carries each model's exact ladder from OpenRouter (BYOK models borrow their
// OpenRouter twin's); these family ladders only cover ids the catalog could
// not describe, such as while the probe is down.
const DEFAULT_EFFORTS = ["low", "medium", "high"] as const;
const OPENAI_EFFORTS = ["none", "low", "medium", "high", "xhigh"] as const;
const ANTHROPIC_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

interface EffortSource {
  value: string;
  reasoning_efforts?: string[] | null;
}

/** The reasoning-effort ladder a model actually supports, weakest first.
 * Prefers the catalog's per-model ladder when ``models`` knows the id. */
export function effortsFor(
  model: string | null,
  models?: readonly EffortSource[] | null,
): readonly string[] {
  if (!model) return DEFAULT_EFFORTS;
  const fromCatalog = models?.find((m) => m.value === model)?.reasoning_efforts;
  if (fromCatalog) return fromCatalog;
  if (model.includes("anthropic/claude")) return ANTHROPIC_EFFORTS;
  // Matches both direct ids and OpenRouter-prefixed ones ("openrouter/openai/…").
  if (model.includes("openai/")) return OPENAI_EFFORTS;
  return DEFAULT_EFFORTS;
}

/** Localized display label for a reasoning-effort level. */
export function effortLabel(level: string): string {
  switch (level) {
    case "none":
      return msg("agent.model_menu.effort_none");
    case "minimal":
      return msg("agent.model_menu.effort_minimal");
    case "low":
      return msg("agent.model_menu.effort_low");
    case "medium":
      return msg("agent.model_menu.effort_medium");
    case "high":
      return msg("agent.model_menu.effort_high");
    case "xhigh":
      return msg("agent.model_menu.effort_xhigh");
    case "max":
      return msg("agent.model_menu.effort_max");
    default:
      return level;
  }
}
