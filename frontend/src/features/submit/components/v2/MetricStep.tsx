"use client";

import * as React from "react";
import { useCodeAgent } from "@/shared/hooks/use-code-agent";
import type { ValidateCodeResponse } from "@/shared/types/api";
import type { UnifiedAuthoringContext, UnifiedCase } from "@/shared/types/unified-run";
import { useWizardV2 } from "../../hooks/use-unified-wizard";
import { useContractCheck } from "../../hooks/use-contract-check";
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
 * Step 4, one screen: the coding agent writes the run code and the metric in
 * the side panel, the user can edit either, and the validity check below the
 * editors confirms the code and the data agree before Run.
 */
export function MetricStep() {
  const ctx = useWizardV2();
  const { state, patchTask, patchWorkspace, metricShape, guided } = ctx;
  const { task, inputs, optimizer, workspace } = state;
  const kind = task.artifactKind;
  const t = (key: string) => v2Msg(key, guided);

  // Code already in a slot (a cloned run, or the user's own) is never
  // overwritten by the agent's first draft.
  const [runEdited, setRunEdited] = React.useState(() => workspace.runCode.trim().length > 0);
  const [metricEdited, setMetricEdited] = React.useState(
    () => workspace.metricCode.trim().length > 0,
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
  const setupIncomplete = authoringContext === null;

  return (
    <div className="h-full">
      <AuthoringShell
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
        <div className="min-h-0 flex-1 overflow-y-auto">
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
            agent={agent}
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
        </div>
      </AuthoringShell>
    </div>
  );
}
