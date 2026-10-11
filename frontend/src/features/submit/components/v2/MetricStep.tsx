"use client";

import * as React from "react";
import { useCodeAgent } from "@/shared/hooks/use-code-agent";
import type { ValidateCodeResponse } from "@/shared/types/api";
import type { UnifiedAuthoringContext, UnifiedCase } from "@/shared/types/unified-run";
import { useWizardV2 } from "../../hooks/use-unified-wizard";
import { useContractCheck } from "../../hooks/use-contract-check";
import {
  runHint,
  seedWorkspace,
  shapeHint,
  starterMetricCode,
  starterRunCode,
  type TemplateFields,
} from "../../lib/metric-templates";
import { metricUsesModel as metricCallsModel } from "../../lib/scorer-dependencies";
import { AuthoringShell } from "../steps/AuthoringShell";
import { CodeAgentPanel } from "../steps/CodeAgentPanel";
import { v2Msg } from "./ArtifactConfirmCard";
import { CodeWorkspace } from "./CodeWorkspace";
import { ContractCheckPanel } from "./ContractCheckPanel";
import { MetricModelRow } from "./MetricModelRow";

const NO_ROLES: Record<string, string> = {};
const NO_KINDS: Record<string, "text" | "image"> = {};
const SAMPLE_CASE_LIMIT = 5;
const noop = () => {};
// The unified workspace has no per-editor validation endpoint: the contract
// check validates run and metric together.
const noValidation = async (): Promise<ValidateCodeResponse | null> => null;

/**
 * True when the slot holds code someone wrote, as opposed to nothing or the
 * untouched template. The agent may replace a template, never authored code.
 */
function isAuthored(code: string, template: string | null): boolean {
  return code.trim().length > 0 && code !== template;
}

/**
 * Step 4: the run code and the metric, written by the agent in the side panel
 * or by hand, with the contract check that gates Run.
 */
export function MetricStep() {
  const ctx = useWizardV2();
  const { state, patchTask, patchWorkspace, metricShape, guided } = ctx;
  const { task, inputs, optimizer, workspace } = state;
  const kind = task.artifactKind;
  const t = (key: string) => v2Msg(key, guided);

  const fields = React.useMemo<TemplateFields>(
    () => ({ inputFields: inputs.inputFields, expectedField: inputs.expectedField }),
    [inputs.inputFields, inputs.expectedField],
  );

  // Templates fill empty slots only. Code that no longer fits a changed
  // artifact kind or metric shape is kept; the contract check shows why.
  React.useEffect(() => {
    const patch = seedWorkspace(
      { runCode: workspace.runCode, metricCode: workspace.metricCode },
      kind,
      metricShape,
      fields,
    );
    if (patch) patchWorkspace(patch);
    // Only a new kind or shape (or entering the step) seeds; clearing an
    // editor by hand must not refill it on the next keystroke.
  }, [kind, metricShape]);

  const [codeAssistMode, setCodeAssistMode] = React.useState<"auto" | "manual">("auto");
  const [runEdited, setRunEdited] = React.useState(() =>
    isAuthored(workspace.runCode, kind ? starterRunCode(kind, fields) : null),
  );
  const [metricEdited, setMetricEdited] = React.useState(() =>
    isAuthored(workspace.metricCode, metricShape ? starterMetricCode(metricShape, fields) : null),
  );
  const [agentModel, setAgentModel] = React.useState<string | null>(null);
  const [agentEffort, setAgentEffort] = React.useState<string | null>(null);

  const metricUsesModel = metricCallsModel(state);

  const authoringContext = React.useMemo<UnifiedAuthoringContext | null>(() => {
    if (!kind || !inputs.mode || !metricShape) return null;
    const samples =
      inputs.cases.length > 0
        ? inputs.cases
            .slice(0, SAMPLE_CASE_LIMIT)
            .map((c: UnifiedCase) => ({ input: c.input, expected: c.expected ?? null }))
        : inputs.sampleRows.slice(0, SAMPLE_CASE_LIMIT);
    return {
      task: {
        objective: task.objective,
        background: task.background,
        artifact: { kind, starting_version: task.startingVersion ?? "" },
      },
      data_mode: inputs.mode,
      input_fields: inputs.inputFields,
      expected_field: inputs.expectedField,
      sample_cases: samples,
      optimizer: optimizer.choice,
      metric_shape: metricShape,
      metric_has_model: metricUsesModel,
      focus: "run",
    };
  }, [
    kind,
    metricShape,
    metricUsesModel,
    task.objective,
    task.background,
    task.startingVersion,
    inputs.mode,
    inputs.cases,
    inputs.sampleRows,
    inputs.inputFields,
    inputs.expectedField,
    optimizer.choice,
  ]);

  const setRunCode = React.useCallback(
    (code: string) => patchWorkspace({ runCode: code }),
    [patchWorkspace],
  );
  const setMetricCode = React.useCallback(
    (code: string) => patchWorkspace({ metricCode: code }),
    [patchWorkspace],
  );
  const onBrief = React.useCallback(
    (brief: { objective?: string; background?: string }) => {
      const patch: { objective?: string; background?: string } = {};
      if (brief.objective !== undefined) patch.objective = brief.objective;
      if (brief.background !== undefined) patch.background = brief.background;
      if (Object.keys(patch).length > 0) patchTask(patch);
    },
    [patchTask],
  );

  const agent = useCodeAgent({
    codeAssistMode,
    setCodeAssistMode,
    columnRoles: NO_ROLES,
    columnKinds: NO_KINDS,
    parsedDataset: null,
    moduleName: "",
    signatureCode: workspace.runCode,
    metricCode: workspace.metricCode,
    setSignatureCode: setRunCode,
    setMetricCode,
    signatureManuallyEdited: runEdited,
    metricManuallyEdited: metricEdited,
    setSignatureManuallyEdited: setRunEdited,
    setMetricManuallyEdited: setMetricEdited,
    setSignatureValidation: noop,
    setMetricValidation: noop,
    signatureValidation: null,
    metricValidation: null,
    runSignatureValidation: noValidation,
    runMetricValidation: noValidation,
    seedEnabled: authoringContext !== null,
    unified: authoringContext,
    onBrief,
    model: agentModel,
    reasoningEffort: agentEffort,
  });

  const contract = useContractCheck(ctx);
  const auto = codeAssistMode === "auto";
  const setupIncomplete = authoringContext === null;

  return (
    <div className="space-y-4">
      <AuthoringShell
        value={codeAssistMode}
        onChange={setCodeAssistMode}
        disabledReason={setupIncomplete ? t("submit.v2.metric.agent.needs_setup") : undefined}
        title={t("submit.v2.metric.title")}
        description={t("submit.v2.metric.desc")}
        sidePanel={
          <CodeAgentPanel
            agent={agent}
            unified
            disabled={setupIncomplete}
            disabledReason={setupIncomplete ? t("submit.v2.metric.agent.needs_setup") : undefined}
            className="absolute inset-0"
            model={agentModel}
            onModelChange={setAgentModel}
            reasoningEffort={agentEffort}
            onReasoningEffortChange={setAgentEffort}
          />
        }
      >
        <CodeWorkspace
          runCode={workspace.runCode}
          metricCode={workspace.metricCode}
          onRunCodeChange={(code) => {
            setRunCode(code);
            setRunEdited(true);
          }}
          onMetricCodeChange={(code) => {
            setMetricCode(code);
            setMetricEdited(true);
          }}
          runHint={kind ? runHint(kind) : ""}
          metricHint={metricShape ? shapeHint(metricShape) : ""}
          agent={auto ? agent : null}
          guided={guided}
        >
          {metricUsesModel && (
            <MetricModelRow
              mode={workspace.metricModelMode}
              explicitModel={workspace.metricModel}
              reflectionModel={optimizer.reflectionModel}
              onChange={patchWorkspace}
              guided={guided}
            />
          )}
        </CodeWorkspace>
        <ContractCheckPanel cc={contract} guided={guided} blockedReason={ctx.runBlockedReason} />
      </AuthoringShell>
    </div>
  );
}
