/**
 * Starter code for the wizard v2 workspace (contract D3).
 *
 * `run_code` depends on the artifact kind: `run(artifact, input) -> output`,
 * or `build_program() -> dspy.Module` for a DSPy program. The metric depends
 * on the shape the resolved optimizer calls. Templates only fill empty slots;
 * code the user or the agent wrote is never replaced.
 */
import type { ArtifactKind, MetricShape } from "@/shared/types/unified-run";

export interface TemplateFields {
  inputFields: readonly string[];
  expectedField: string | null;
}

const DEFAULT_INPUT_FIELD = "question";
const DEFAULT_OUTPUT_FIELD = "answer";

const PY_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Column names that are valid Python identifiers; DSPy signatures need them. */
function identifiers(names: readonly string[]): string[] {
  return names.filter((name) => PY_IDENTIFIER.test(name));
}

function outputField(fields: TemplateFields): string {
  const field = fields.expectedField;
  return field && PY_IDENTIFIER.test(field) ? field : DEFAULT_OUTPUT_FIELD;
}

const PROMPT_RUN = `from skynet import llm


def run(artifact, input):
    # artifact: the prompt version being tried (a string, or a dict of named parts).
    # input: one case's input fields.
    prompt = artifact if isinstance(artifact, str) else "\\n\\n".join(artifact.values())
    return llm(prompt, input=input)
`;

const CODE_RUN = `def run(artifact, input):
    # artifact: the source code version being tried. It defines solve(**input).
    namespace = {}
    exec(artifact, namespace)
    return namespace["solve"](**input)
`;

const TEXT_RUN = `def run(artifact, input):
    # artifact: the text version being tried. The metric judges it directly.
    return artifact
`;

function dspyRun(fields: TemplateFields): string {
  const inputs = identifiers(fields.inputFields);
  const signature = `${(inputs.length > 0 ? inputs : [DEFAULT_INPUT_FIELD]).join(", ")} -> ${outputField(fields)}`;
  return `import dspy


class Program(dspy.Module):
    def __init__(self):
        super().__init__()
        self.predict = dspy.ChainOfThought("${signature}")

    def forward(self, **inputs):
        return self.predict(**inputs)


def build_program():
    return Program()
`;
}

/** Starter `run_code` for an artifact kind. */
export function starterRunCode(kind: ArtifactKind, fields: TemplateFields): string {
  switch (kind) {
    case "dspy_program":
      return dspyRun(fields);
    case "code":
      return CODE_RUN;
    case "text":
      return TEXT_RUN;
    case "prompt":
      return PROMPT_RUN;
  }
}

function dspyFeedbackMetric(field: string): string {
  return `import dspy


def metric(gold, pred, trace=None, pred_name=None, pred_trace=None):
    expected = str(gold.${field}).strip()
    got = str(pred.${field}).strip()
    if got == expected:
        return dspy.Prediction(score=1.0, feedback="Correct.")
    return dspy.Prediction(
        score=0.0,
        feedback=f"Expected {expected!r} but got {got!r}.",
    )
`;
}

function dspyScalarMetric(field: string): string {
  return `def metric(gold, pred, trace=None):
    return float(str(pred.${field}).strip() == str(gold.${field}).strip())
`;
}

const BLACKBOX_METRIC = `def score(input, output, expected=None):
    if expected is None:
        return 0.0, {"feedback": "No expected output to compare against."}
    if str(output).strip() == str(expected).strip():
        return 1.0, {"feedback": "Matches the expected output."}
    return 0.0, {"feedback": f"Expected {expected!r} but got {output!r}."}
`;

/** Starter metric code for the shape the resolved optimizer calls. */
export function starterMetricCode(shape: MetricShape, fields: TemplateFields): string {
  switch (shape) {
    case "dspy_feedback":
      return dspyFeedbackMetric(outputField(fields));
    case "dspy_scalar":
      return dspyScalarMetric(outputField(fields));
    case "blackbox_side_info":
      return BLACKBOX_METRIC;
  }
}

/** The one-line metric signature shown above the metric editor. Code, so never translated. */
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

/** The one-line run signature shown above the run editor. */
export function runHint(kind: ArtifactKind): string {
  return kind === "dspy_program"
    ? "build_program() -> dspy.Module"
    : "run(artifact, input) -> output";
}

/**
 * The template patch for empty slots only, or null when both already hold
 * code. A slot with code is kept even when its shape no longer fits; the
 * contract check reports that mismatch instead.
 */
export function seedWorkspace(
  current: { runCode: string; metricCode: string },
  kind: ArtifactKind | null,
  shape: MetricShape | null,
  fields: TemplateFields,
): { runCode?: string; metricCode?: string } | null {
  const patch: { runCode?: string; metricCode?: string } = {};
  if (kind && !current.runCode.trim()) patch.runCode = starterRunCode(kind, fields);
  if (shape && !current.metricCode.trim()) patch.metricCode = starterMetricCode(shape, fields);
  return Object.keys(patch).length > 0 ? patch : null;
}
