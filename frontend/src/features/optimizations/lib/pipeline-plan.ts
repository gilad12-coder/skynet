/**
 * Per-run pipeline plan for the stage tracker.
 *
 * Every flow validates, splits, measures a baseline and evaluates the winner,
 * but the middle differs by optimization type and algorithm: a DSPy compile
 * (MIPROv2, BootstrapFewShot…), a GEPA reflective search, a single black-box
 * engine, or the auto strategy's parallel exploration followed by a GEPA
 * refinement lane. The plan names those stages and their algorithm so the
 * tracker reads as the run that actually happened.
 */
import type {
  BlackboxStrategy,
  OptimizationPayloadResponse,
  OptimizationStatusResponse,
} from "@/shared/types/api";
import { TERMS } from "@/shared/lib/terms";
import { formatMsg, msg } from "@/shared/lib/messages";
import type { PipelineStage } from "../constants";

export interface PlannedStage {
  key: PipelineStage;
  label: string;
  /** The algorithm behind the stage, shown under the label. */
  detail?: string;
}

const ENGINE_LABELS: Record<string, string> = {
  gepa: "GEPA",
  best_of_n: "Best-of-N",
  autoresearch: "AutoResearch",
  meta_harness: "Meta-Harness",
  autosaddler: "AutoSaddler",
};

const HILL_CLIMBING_ENGINES = new Set(["autoresearch", "meta_harness", "autosaddler"]);

function engineLabel(engine: string): string {
  return ENGINE_LABELS[engine.toLowerCase()] ?? engine;
}

// Optimizer names arrive as dotted DSPy paths ("dspy.teleprompt.MIPROv2") or
// the bare "gepa" alias; the tracker wants the class name alone.
function optimizerLabel(raw: string): string {
  const name = raw.split(".").pop() ?? raw;
  return name.toLowerCase() === "gepa" ? "GEPA" : name;
}

function middleStages(
  job: OptimizationStatusResponse,
  payload: OptimizationPayloadResponse | null | undefined,
): PlannedStage[] {
  if (job.optimization_type !== "blackbox") {
    const optimizer = job.optimizer_name ?? "";
    const isGepa = job.module_name === "react" || optimizer.toLowerCase() === "gepa";
    if (isGepa) {
      const detail = job.module_name === "react" ? "GEPA · ReAct" : "GEPA";
      return [{ key: "optimizing", label: msg("pipeline.stage.reflectiveSearch"), detail }];
    }
    if (optimizer)
      return [
        {
          key: "optimizing",
          label: msg("pipeline.stage.compile"),
          detail: optimizerLabel(optimizer),
        },
      ];
    return [{ key: "optimizing", label: TERMS.optimization }];
  }

  const events = job.progress_events ?? [];
  const lanes = events.filter((e) => e.event === "lane_started");
  const singleLane = lanes.find((e) => e.metrics?.phase === "single");
  const strategy = payload?.payload.strategy as Partial<BlackboxStrategy> | undefined;
  const singleEngine =
    (singleLane?.metrics?.engine as string | undefined) ??
    (strategy?.mode === "single" ? (strategy.engine ?? job.blackbox_result?.engine_used) : null);

  if (singleEngine) {
    const id = singleEngine.toLowerCase();
    const label =
      id === "gepa"
        ? msg("pipeline.stage.reflectiveSearch")
        : id === "best_of_n"
          ? msg("pipeline.stage.sampling")
          : HILL_CLIMBING_ENGINES.has(id)
            ? msg("pipeline.stage.hillClimbing")
            : TERMS.optimization;
    return [{ key: "optimizing", label, detail: engineLabel(singleEngine) }];
  }

  // The auto strategy (the default) races explore lanes, then hands the best
  // candidate to a GEPA lane to refine.
  const exploreEngines = new Set(
    lanes
      .filter((e) => e.metrics?.phase === "explore")
      .map((e) => e.metrics?.engine)
      .filter((engine): engine is string => typeof engine === "string"),
  );
  return [
    {
      key: "optimizing",
      label: msg("pipeline.stage.exploration"),
      detail:
        exploreEngines.size > 0
          ? formatMsg("pipeline.stage.lanes", { p1: exploreEngines.size })
          : undefined,
    },
    { key: "refining", label: msg("pipeline.stage.refinement"), detail: "GEPA" },
  ];
}

export function planPipelineStages(
  job: OptimizationStatusResponse,
  payload: OptimizationPayloadResponse | null | undefined,
): PlannedStage[] {
  return [
    { key: "validating", label: msg("auto.features.optimizations.constants.literal.1") },
    { key: "splitting", label: msg("auto.features.optimizations.constants.literal.2") },
    { key: "baseline", label: TERMS.baselineScore },
    ...middleStages(job, payload),
    { key: "evaluating", label: msg("auto.features.optimizations.constants.literal.3") },
  ];
}
