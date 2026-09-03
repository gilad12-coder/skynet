import type {
  BlackboxEngineCatalogResponse,
  BlackboxEngineId,
  BlackboxProposerRuntime,
  BlackboxStrategy,
} from "@/shared/types/api";
import type { MessageKey } from "@/shared/lib/generated/ui-catalog";

export function usesNativeProposer(
  mode: BlackboxStrategy["mode"],
  engine: BlackboxEngineId | null,
): boolean {
  return mode !== "single" || engine === "meta_harness" || engine === "autoresearch";
}

export function supportsIterationLimit(
  mode: BlackboxStrategy["mode"],
  engine: BlackboxEngineId | null,
): boolean {
  return mode === "single" && engine === "meta_harness";
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
  runtime: BlackboxProposerRuntime;
  hasParts: boolean;
  trainingCaseCount: number | null;
}): EngineIssue | null {
  const { catalog, mode, engine, runtime, hasParts } = input;
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
    const selectedRuntime = catalog.proposer_runtimes?.find((item) => item.id === runtime);
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
