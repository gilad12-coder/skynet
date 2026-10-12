/**
 * What blocks each wizard step, and so what blocks Run. Pure, so the gate the
 * wizard enforces is the gate the tests check, at every experience level.
 */
import type { ModelConfig } from "@/shared/types/api";
import { optimizersFor, type OptimizerCatalogResponse } from "@/shared/types/unified-run";

import { inputsIssue } from "./inputs-mode";
import { metricUsesModel } from "./scorer-dependencies";
import {
  WIZARD_V2_STEPS,
  contractSnapshot,
  resolvedMetricModel,
  type TaskSlice,
  type WizardStepId,
  type WizardV2State,
} from "./wizard-v2";

export const hasModel = (config: ModelConfig | null | undefined): config is ModelConfig =>
  Boolean(config?.name.trim());

function startingVersionEmpty(version: TaskSlice["startingVersion"]): boolean {
  if (version === null) return true;
  if (typeof version === "string") return !version.trim();
  const parts = Object.values(version);
  return parts.length === 0 || parts.every((part) => !part.trim());
}

/** The catalog entry for the current choice, when the catalog matches the setup. */
function catalogOption(state: WizardV2State, catalog: OptimizerCatalogResponse | null) {
  if (
    !catalog ||
    catalog.artifact_kind !== state.task.artifactKind ||
    catalog.data_mode !== state.inputs.mode
  )
    return undefined;
  return catalog.options.find((option) => option.id === state.optimizer.choice) ?? null;
}

/** The message key (or exact text) of what blocks one step; null when it is complete. */
export function computeStepIssue(
  state: WizardV2State,
  step: WizardStepId,
  catalog: OptimizerCatalogResponse | null,
): string | null {
  const { task, inputs, optimizer, workspace } = state;
  switch (step) {
    case "task":
      if (!task.objective.trim()) return "submit.v2.task.issue.objective";
      if (!task.artifactKind) return "submit.v2.task.issue.kind";
      if (startingVersionEmpty(task.startingVersion)) return "submit.v2.task.issue.starting";
      return task.confirmed ? null : "submit.v2.task.artifact.confirm_hint";
    case "inputs": {
      const caseCount =
        inputs.cases.length > 0 ? inputs.cases.length : inputs.stagedDatasetId ? inputs.rowCount : 0;
      return inputsIssue({
        mode: inputs.mode,
        caseCount,
        inputFields: inputs.inputFields,
        expectedField: inputs.expectedField,
        split: inputs.split,
      });
    }
    case "optimizer": {
      const kind = task.artifactKind;
      if (!kind || !inputs.mode) return "submit.v2.optimizer.needs_setup";
      if (!optimizersFor(kind, inputs.mode).includes(optimizer.choice))
        return "submit.v2.optimizer.issue.choice";
      const option = catalogOption(state, catalog);
      if (option === null) return "submit.v2.optimizer.issue.choice";
      if (option && !option.available) return "submit.v2.optimizer.issue.unavailable";
      if (kind === "dspy_program" && !hasModel(optimizer.taskModel))
        return "submit.v2.optimizer.models.task.required";
      if (!hasModel(optimizer.reflectionModel))
        return "submit.v2.optimizer.models.reflection.required";
      return null;
    }
    case "metric": {
      if (!workspace.runCode.trim()) return "submit.v2.metric.issue.run_code";
      if (!workspace.metricCode.trim()) return "submit.v2.metric.issue.metric_code";
      if (metricUsesModel(state) && !hasModel(resolvedMetricModel(state)))
        return "submit.v2.metric.model.required";
      if (!workspace.lastCheck) return "submit.v2.metric.check.needed";
      if (workspace.lastCheckSnapshot !== contractSnapshot(state))
        return "submit.v2.metric.check.stale";
      return workspace.lastCheck.ok ? null : "submit.v2.metric.check.failed";
    }
  }
}

/**
 * Why Run is blocked, or null when it may run. A failed validity check reports
 * its first failing item's exact text, so the person sees what to fix.
 */
export function runBlockedReason(
  state: WizardV2State,
  catalog: OptimizerCatalogResponse | null,
): string | null {
  for (const step of WIZARD_V2_STEPS) {
    const issue = computeStepIssue(state, step, catalog);
    if (!issue) continue;
    if (issue === "submit.v2.metric.check.failed") {
      const failed = state.workspace.lastCheck?.checks.find((item) => item.status === "failed");
      return failed ? (failed.detail ?? failed.message) : issue;
    }
    return issue;
  }
  return null;
}
