"use client";

import * as React from "react";
import {
  AgentPanelDock,
  isGeneralistAgentEnabled,
  useWizardStateOptional,
} from "@/features/agent-panel";
import type { UnifiedAuthoringContext, UnifiedCase } from "@/shared/types/unified-run";
import { useWizardV2 } from "../../hooks/use-unified-wizard";
import { useContractCheck } from "../../hooks/use-contract-check";
import { authoringCases } from "../../lib/inputs-mode";
import { metricUsesModel as metricCallsModel } from "../../lib/scorer-dependencies";
import { AuthoringShell } from "../steps/AuthoringShell";
import { v2Msg } from "./ArtifactConfirmCard";
import { CodeWorkspace } from "./CodeWorkspace";
import { ContractCheckScreen } from "./ContractCheckScreen";
import { MetricModelRow } from "./MetricModelRow";
import { RunOverview } from "./RunOverview";
import { WizardScreen } from "./WizardScreen";

const SAMPLE_CASE_LIMIT = 5;
const NOT_WRITING = { run: false, metric: false, files: [] };

/**
 * Step 4, three screens. First the code: the docked agent's coding tool
 * writes run.py, metric.py and any helper files into the workspace, and the
 * user can open and edit each one. Then the sandbox check, which runs the
 * code on a few samples. Then the overview, which holds Run, so the run
 * button never covers the editors.
 */
export function MetricStep({ page, onBack }: { page: number; onBack: () => void }) {
  const ctx = useWizardV2();
  const { state, patchWorkspace, setWorkspaceFile, guided, optimizerCatalog, inputsInferring } =
    ctx;
  const { task, inputs, optimizer, workspace } = state;
  const kind = task.artifactKind;
  const repo = Boolean(task.repo);
  const t = (key: string) => v2Msg(key, guided);

  const metricUsesModel = metricCallsModel(state);
  const catalog =
    optimizerCatalog?.artifact_kind === kind && optimizerCatalog.data_mode === inputs.mode
      ? optimizerCatalog
      : null;
  const metricSignature = catalog?.metric_signature ?? null;

  const authoringContext = React.useMemo<UnifiedAuthoringContext | null>(() => {
    if (!kind || !inputs.mode) return null;
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
      metric_has_model: metricUsesModel,
      focus: "run",
    };
  }, [
    kind,
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
  const deleteFile = React.useCallback(
    (path: string) => setWorkspaceFile(path, null),
    [setWorkspaceFile],
  );

  // The docked agent's coding tool writes under this context, into these
  // editors' code. Inference re-roles the columns when it answers, and the
  // Inputs step stays mounted while it does, so code written earlier would
  // target input fields the contract check and the run no longer pass. A
  // repository run has no sample inputs to write against; its scorer is
  // written by hand.
  const wizardCtx = useWizardStateOptional();
  const registerContext = wizardCtx?.setAuthoringContext;
  const sharedContext = repo || inputsInferring ? null : authoringContext;
  React.useEffect(() => {
    registerContext?.(sharedContext);
  }, [registerContext, sharedContext]);
  React.useEffect(() => () => registerContext?.(null), [registerContext]);
  const registerSink = wizardCtx?.setCodeSink;
  React.useEffect(() => {
    if (!registerSink) return;
    registerSink((slot, code) => (slot === "run" ? setRunCode(code) : setMetricCode(code)));
    return () => registerSink(null);
  }, [registerSink, setRunCode, setMetricCode]);
  const registerFileSink = wizardCtx?.setFileSink;
  React.useEffect(() => {
    if (!registerFileSink) return;
    registerFileSink(setWorkspaceFile);
    return () => registerFileSink(null);
  }, [registerFileSink, setWorkspaceFile]);
  // The coding agent reads the extra files from here, to send them with each turn.
  const shareFiles = wizardCtx?.setWorkspaceFiles;
  React.useEffect(() => {
    shareFiles?.(workspace.files);
  }, [shareFiles, workspace.files]);
  React.useEffect(() => () => shareFiles?.({}), [shareFiles]);

  const writing = wizardCtx?.codeWriting ?? NOT_WRITING;
  // The wizard agent sits beside the editors; its coding tool writes the code.
  const agentEnabled = isGeneralistAgentEnabled();
  const agentShown = agentEnabled && state.step === "metric" && page === 0;
  const { setAgentWriting } = ctx;
  const agentStreaming = writing.run || writing.metric || writing.files.length > 0;
  React.useEffect(() => {
    setAgentWriting(agentStreaming);
    return () => setAgentWriting(false);
  }, [agentStreaming, setAgentWriting]);

  const contract = useContractCheck(ctx);
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
          value={agentEnabled ? "auto" : "manual"}
          title={t("submit.v2.metric.title")}
          description={t("submit.v2.metric.desc")}
          sidePanel={agentShown ? <AgentPanelDock className="absolute inset-0" /> : null}
        >
          <div className="min-h-0 flex-1 overflow-y-auto">
            <CodeWorkspace
              runCode={workspace.runCode}
              metricCode={workspace.metricCode}
              files={workspace.files}
              runEntry={catalog?.run_entry ?? null}
              metricSignature={metricSignature}
              onFileChange={setWorkspaceFile}
              onFileDelete={deleteFile}
              writing={writing}
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
