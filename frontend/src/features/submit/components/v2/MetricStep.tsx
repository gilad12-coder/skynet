"use client";

import * as React from "react";
import { useCodeAgent } from "@/shared/hooks/use-code-agent";
import type { ValidateCodeResponse } from "@/shared/types/api";
import type { UnifiedAuthoringContext, UnifiedCase } from "@/shared/types/unified-run";
import { useWizardV2 } from "../../hooks/use-unified-wizard";
import { useContractCheck } from "../../hooks/use-contract-check";
import { authoringCases } from "../../lib/inputs-mode";
import { metricUsesModel as metricCallsModel } from "../../lib/scorer-dependencies";
import { AuthoringShell } from "../steps/AuthoringShell";
import { CodeAgentPanel } from "../steps/CodeAgentPanel";
import { v2Msg } from "./ArtifactConfirmCard";
import { CodeWorkspace } from "./CodeWorkspace";
import { ContractCheckScreen } from "./ContractCheckScreen";
import { MetricModelRow } from "./MetricModelRow";
import { RunOverview } from "./RunOverview";
import { WizardScreen } from "./WizardScreen";

const NO_ROLES: Record<string, string> = {};
const NO_KINDS: Record<string, "text" | "image"> = {};
const SAMPLE_CASE_LIMIT = 5;
const noop = () => {};
// The unified workspace has no per-editor validation endpoint: the contract
// check validates run and metric together.
const noValidation = async (): Promise<ValidateCodeResponse | null> => null;

/**
 * Step 4, three screens. First the code: the coding agent writes the run code
 * and the metric in the side panel, and the user can edit either. Then the
 * sandbox check, which runs both on a few samples. Then the overview, which
 * holds Run, so the run button never covers the editors.
 */
export function MetricStep({ page, onBack }: { page: number; onBack: () => void }) {
  const ctx = useWizardV2();
  const { state, patchTask, patchWorkspace, metricShape, guided, optimizerCatalog, inputsInferring } =
    ctx;
  const { task, inputs, optimizer, workspace } = state;
  const kind = task.artifactKind;
  const repo = Boolean(task.repo);
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
  const catalog =
    optimizerCatalog?.artifact_kind === kind && optimizerCatalog.data_mode === inputs.mode
      ? optimizerCatalog
      : null;
  const metricSignature =
    catalog?.options.find((option) => option.id === optimizer.choice)?.metric_signature ?? null;

  const authoringContext = React.useMemo<UnifiedAuthoringContext | null>(() => {
    if (!kind || !inputs.mode || !metricShape) return null;
    const samples = authoringCases(
      {
        cases: inputs.cases,
        sampleRows: inputs.sampleRows,
        inputFields: inputs.inputFields,
        expectedField: inputs.expectedField,
      },
      SAMPLE_CASE_LIMIT,
    ).map((c: UnifiedCase) => ({ input: c.input, expected: c.expected ?? null }));
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
    // Inference re-roles the columns when it answers, and the Inputs step
    // stays mounted while it does, so a seed started earlier would write
    // against input fields the contract check and the run no longer pass.
    // The agent writes run code against sample inputs, which a repository
    // run has neither of; its scorer is written by hand.
    seedEnabled: !repo && authoringContext !== null && !inputsInferring,
    unified: authoringContext,
    onBrief,
    model: agentModel,
    reasoningEffort: agentEffort,
  });

  const { setAgentWriting } = ctx;
  const agentStreaming = agent.status === "streaming";
  React.useEffect(() => {
    setAgentWriting(agentStreaming);
    return () => setAgentWriting(false);
  }, [agentStreaming, setAgentWriting]);

  const contract = useContractCheck(ctx);
  const setupIncomplete = repo || authoringContext === null;
  // Until a fresh sandboxed check exists, the editors' consoles show what the
  // static check spotted while typing.
  const staticFailed = contract.staticResult?.checks.some((item) => item.status === "failed");
  const consoleResult =
    staticFailed && (!contract.lastCheck || contract.stale)
      ? contract.staticResult
      : contract.lastCheck;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <WizardScreen active={page === 0} className="flex flex-col overflow-hidden">
        <AuthoringShell
          title={t("submit.v2.metric.title")}
          description={t("submit.v2.metric.desc")}
          sidePanel={
            <CodeAgentPanel
              agent={agent}
              unified
              disabled={setupIncomplete}
              disabledReason={
                repo
                  ? t("submit.v2.repo.agent_off")
                  : setupIncomplete
                    ? t("submit.v2.metric.agent.needs_setup")
                    : undefined
              }
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
              runEntry={catalog?.run_entry ?? null}
              metricSignature={metricSignature}
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
              checkResult={consoleResult}
              onCheck={contract.check}
              repo={repo}
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
          </div>
        </AuthoringShell>
      </WizardScreen>
      {!repo && (
        <WizardScreen active={page === 1}>
          <ContractCheckScreen cc={contract} guided={guided} active={page === 1} onBack={onBack} />
        </WizardScreen>
      )}
      {/* A repository run has no check screen, so its overview is the second page. */}
      <WizardScreen active={page === (repo ? 1 : 2)} className="flex flex-col overflow-hidden">
        <RunOverview state={state} cc={contract} guided={guided} />
      </WizardScreen>
    </div>
  );
}
