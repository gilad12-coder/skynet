export type PipelineStage =
  | "validating"
  | "splitting"
  | "baseline"
  | "optimizing"
  | "refining"
  | "evaluating"
  | "done";
