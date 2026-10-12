/**
 * The one-line signatures shown above the Metric step's editors: the contract
 * the validity check holds the run code and the metric to. The coding agent
 * writes the code itself. Code, so never translated.
 */
import type { ArtifactKind, MetricShape } from "@/shared/types/unified-run";

/** The metric signature the resolved optimizer calls. */
export function shapeHint(shape: MetricShape): string {
  switch (shape) {
    case "dspy_feedback":
      return "metric(gold, pred, trace=None, pred_name=None, pred_trace=None) -> dspy.Prediction(score=float, feedback=str)";
    case "dspy_scalar":
      return "metric(gold, pred, trace=None) -> float | bool";
    case "blackbox_side_info":
      return 'score(input, output, expected=None) -> (float, {"feedback": str})';
  }
}

/** The run code's entrypoint: the DSPy optimizers compile a module, so a DSPy program builds one. */
export function runHint(kind: ArtifactKind): string {
  return kind === "dspy_program"
    ? "build_program() -> dspy.Module"
    : "run(artifact, input) -> output";
}
