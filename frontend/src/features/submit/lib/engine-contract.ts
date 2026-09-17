import type {
  BlackboxEngineCatalogResponse,
  BlackboxEngineId,
  BlackboxHarness,
  BlackboxProposer,
  BlackboxStrategy,
} from "@/shared/types/api";
import type { MessageKey } from "@/shared/lib/generated/ui-catalog";

export function usesNativeProposer(
  mode: BlackboxStrategy["mode"],
  engine: BlackboxEngineId | null,
): boolean {
  return (
    mode !== "single" ||
    engine === "meta_harness" ||
    engine === "autoresearch" ||
    engine === "autosaddler"
  );
}

/**
 * What a fresh wizard sends when the user never touches the proposer settings.
 *
 * The stall timeout has no control: half an hour without a new score covers a
 * slow scorer pass while still cutting a wedged agent loose. The thinking
 * budget is never set: a fixed budget would silence the effort level, which
 * is the one reasoning control the form offers.
 */
export const DEFAULT_PROPOSER: BlackboxProposer = {
  harness: "claude_code",
  effort: null,
  max_thinking_tokens: null,
  max_candidates_per_iter: 3,
  ralph: true,
  max_no_eval_seconds: 1_800,
};

/** Which engine-specific proposer knobs the strategy exposes; Auto may run any engine. */
export function proposerKnobs(
  mode: BlackboxStrategy["mode"],
  engine: BlackboxEngineId | null,
): { candidates: boolean; ralph: boolean } {
  const auto = mode !== "single";
  return {
    candidates: auto || engine === "meta_harness",
    ralph: auto || engine === "autoresearch",
  };
}

/** The proposer block to submit: knobs the form hides for this strategy go back to their defaults. */
export function submittedProposer(
  proposer: BlackboxProposer,
  mode: BlackboxStrategy["mode"],
  engine: BlackboxEngineId | null,
): BlackboxProposer {
  const knobs = proposerKnobs(mode, engine);
  const reasoning = proposerTunesReasoning(proposer.harness);
  return {
    ...proposer,
    effort: reasoning ? (proposer.effort ?? null) : null,
    max_thinking_tokens: null,
    max_candidates_per_iter: knobs.candidates ? (proposer.max_candidates_per_iter ?? null) : null,
    ralph: knobs.ralph ? (proposer.ralph ?? DEFAULT_PROPOSER.ralph) : DEFAULT_PROPOSER.ralph,
    max_no_eval_seconds: knobs.ralph ? DEFAULT_PROPOSER.max_no_eval_seconds : null,
  };
}

/** Effort is a Claude Code CLI flag; other harnesses ignore it. */
export function proposerTunesReasoning(harness: BlackboxHarness): boolean {
  return harness === "claude_code";
}

export function supportsIterationLimit(
  mode: BlackboxStrategy["mode"],
  engine: BlackboxEngineId | null,
): boolean {
  return mode === "single" && (engine === "meta_harness" || engine === "autosaddler");
}

interface EngineIssue {
  key: MessageKey;
  params?: Record<string, string>;
}

/** Keep configuration available while blocking execution against incomplete capabilities. */
export function engineSelectionIssue(input: {
  catalog: BlackboxEngineCatalogResponse | null;
  mode: BlackboxStrategy["mode"];
  engine: BlackboxEngineId | null;
  hasParts: boolean;
  trainingCaseCount: number | null;
}): EngineIssue | null {
  const { catalog, mode, engine, hasParts } = input;
  if (!catalog) return { key: "submit.blackbox.engines.checking" };
  if (input.trainingCaseCount === 0 && (mode !== "single" || engine === "meta_harness"))
    return { key: "submit.blackbox.validation.training_cases" };
  if (mode === "single") {
    const selected = catalog.engines.find((candidate) => candidate.id === engine);
    if (!selected) return { key: "submit.blackbox.validation.engine_required" };
    if (hasParts && !selected.supports_parts)
      return { key: "submit.blackbox.validation.engine_parts" };
    if (!selected.available) {
      return selected.unavailable_reason?.trim()
        ? {
            key: "submit.blackbox.run_disabled.engine_reason",
            params: { engine: selected.label, reason: selected.unavailable_reason },
          }
        : { key: "submit.blackbox.run_disabled.engine", params: { engine: selected.label } };
    }
  } else {
    if (hasParts) return { key: "submit.blackbox.validation.auto_parts" };
    // Auto is one upstream recipe. A list of visible engines never authorizes
    // silently dropping an unavailable lane from that recipe.
    if (catalog.auto_available !== true) {
      return catalog.auto_unavailable_reason?.trim()
        ? {
            key: "submit.blackbox.run_disabled.auto_reason",
            params: { reason: catalog.auto_unavailable_reason },
          }
        : { key: "submit.blackbox.run_disabled.no_engines" };
    }
  }
  if (usesNativeProposer(mode, engine)) {
    const selectedRuntime = catalog.proposer_runtimes?.find((item) => item.id === "vercel");
    if (!selectedRuntime?.available) {
      return selectedRuntime?.unavailable_reason?.trim()
        ? {
            key: "submit.blackbox.run_disabled.runtime_reason",
            params: { reason: selectedRuntime.unavailable_reason },
          }
        : { key: "submit.blackbox.run_disabled.runtime" };
    }
  }
  return null;
}
