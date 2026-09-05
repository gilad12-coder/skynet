/** Map server payload fields to the stage and control that can correct them. */
export function preflightDestination(
  workflow: "anything" | "dspy",
  field: string | undefined,
  scope: "evaluation" | "execution",
): { stage: "evaluation" | "optimization"; fieldId: string } {
  const key = field?.replace(/^model\./, "") ?? "";
  if (/budget|usage/.test(key)) return { stage: "evaluation", fieldId: "totalBudgetInput" };
  if (workflow === "anything") {
    if (/optimization|reflection|optimizer|strategy/.test(key))
      return {
        stage: "optimization",
        fieldId: /model|optimization|reflection/.test(key) ? "bb-optimization-model" : "bb-engines",
      };
    if (/runtime/.test(key)) return { stage: "optimization", fieldId: "wizard-stage-optimization" };
    if (/scor|evaluation/.test(key))
      return {
        stage: "evaluation",
        fieldId: /model/.test(key) ? "bb-scoring-model" : "bb-scorer-code",
      };
    if (/case|split|dataset/.test(key))
      return { stage: "evaluation", fieldId: "wizard-stage-evaluation" };
    if (/task|target/.test(key))
      return { stage: "optimization", fieldId: "wizard-stage-optimization" };
  } else {
    if (/runtime/.test(key)) return { stage: "optimization", fieldId: "wizard-stage-optimization" };
    if (/model|task|optimization|reflection|generation/.test(key))
      return { stage: "optimization", fieldId: "model-catalog" };
    if (/metric|scor/.test(key)) return { stage: "evaluation", fieldId: "metric-editor" };
    if (/program|signature/.test(key)) return { stage: "evaluation", fieldId: "signature-editor" };
    if (/dataset|sample|mapping|split/.test(key))
      return { stage: "evaluation", fieldId: "dataset-upload" };
  }
  const stage = scope === "evaluation" ? "evaluation" : "optimization";
  return { stage, fieldId: `wizard-stage-${stage}` };
}
