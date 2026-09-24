import { TERMS } from "@/shared/lib/terms";
import { msg } from "@/shared/lib/messages";
import { perLocale } from "@/shared/lib/per-locale";

export type PipelineStage =
  | "validating"
  | "splitting"
  | "baseline"
  | "optimizing"
  | "evaluating"
  | "done";

export const PIPELINE_STAGES: Array<{ key: PipelineStage; label: string }> = perLocale(() => [
  { key: "validating", label: msg("auto.features.optimizations.constants.literal.1") },
  { key: "splitting", label: msg("auto.features.optimizations.constants.literal.2") },
  { key: "baseline", label: TERMS.baselineScore },
  { key: "optimizing", label: TERMS.optimization },
  { key: "evaluating", label: msg("auto.features.optimizations.constants.literal.3") },
]);
