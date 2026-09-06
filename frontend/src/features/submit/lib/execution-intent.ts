export type ExecutionKind = "text" | "agent";
export type ExecutionMode = "auto" | ExecutionKind;

/** Start an agent only when the evaluator explicitly opts into its run record. */
export function resolveExecutionKind(mode: ExecutionMode): ExecutionKind {
  return mode === "agent" ? "agent" : "text";
}

/** Preserve the effective execution of older drafts, including inferred agent runs. */
export function restoreExecutionMode(draft: {
  executionMode?: ExecutionMode;
  targetKind: ExecutionKind;
}): ExecutionKind {
  return draft.executionMode && draft.executionMode !== "auto"
    ? draft.executionMode
    : draft.targetKind;
}
