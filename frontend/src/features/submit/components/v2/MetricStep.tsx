"use client";

import * as React from "react";
import { isGeneralistAgentEnabled, useHideAgentPill } from "@/features/agent-panel";
import { githubRepoFile, githubRepoTree } from "@/shared/lib/api";
import type { UnifiedAuthoringContext, UnifiedCase } from "@/shared/types/unified-run";
import { useWizardV2 } from "../../hooks/use-unified-wizard";
import { useContractCheck } from "../../hooks/use-contract-check";
import { CodingAgentPanel } from "../../ide/CodingAgentPanel";
import { workspaceKey } from "../../ide/agent-verdict";
import { IdeWorkspace } from "../../ide/IdeWorkspace";
import type { IdeOpenRequest } from "../../ide/open-file";
import { indexRepoTree, repoFolderName, type RepoSource } from "../../ide/repo-files";
import { useIdeCodingAgent } from "../../ide/use-ide-coding-agent";
import { authoringCases } from "../../lib/inputs-mode";
import { metricUsesModel as metricCallsModel, withScorerImports } from "../../lib/scorer-dependencies";
import { METRIC_FILE, RUN_FILE, isSingleAnswerTask, repoIssue } from "../../lib/wizard-v2";
import { v2Msg } from "./ArtifactConfirmCard";
import { ContractCheckScreen } from "./ContractCheckScreen";
import { MetricModelRow } from "./MetricModelRow";
import { RunOverview } from "./RunOverview";
import { WizardScreen } from "./WizardScreen";

const SAMPLE_CASE_LIMIT = 5;
// What the black-box runner calls on a repository run, with the checkout's path.
const REPO_SCORER_SIGNATURE = "def score(repo_path, case=None) -> float | dict";

/** The app-wide agent launcher stays hidden while the IDE's own coding agent is on screen. */
function HideAgentPill() {
  useHideAgentPill();
  return null;
}

/**
 * The repository's checkout for the IDE's explorer, read from GitHub at the
 * run's commit (or branch) as the run will clone it.
 *
 * Args:
 *   repository: The repository as `owner/name`.
 *   ref: The commit or branch; empty for the default branch.
 *
 * Returns:
 *   The tree, fetched now, and a reader that fetches each file when it is opened.
 */
function repoSource(repository: string, ref: string): RepoSource {
  return {
    // A repository run's workspace is run.py and metric.py, nothing else.
    folder: repoFolderName(repository, new Set([RUN_FILE, METRIC_FILE])),
    tree: githubRepoTree(repository, ref).then((tree) => indexRepoTree(tree.entries)),
    read: async (path) => {
      const file = await githubRepoFile(repository, ref, path);
      if (file.text !== null) return { text: file.text };
      return { issue: file.binary ? "binary" : file.too_large ? "too_large" : "missing" };
    },
  };
}

/**
 * Step 4, three screens. First the code, in VS Code's workbench: the coding
 * agent docked beside it writes run.py, metric.py and any helper files, and
 * the user can open and edit each one. Then the sandbox check, which runs the
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

  const contract = useContractCheck(ctx);
  const lastCheckOk = contract.lastCheck && !contract.stale ? contract.lastCheck.ok : null;

  // The coding agent writes under this context. Inference re-roles the
  // columns when it answers, and the Inputs step stays mounted while it does,
  // so code written earlier would target input fields the contract check and
  // the run no longer pass. A repository run has no sample inputs to write
  // against; its scorer is written by hand.
  const agentContext = repo || inputsInferring ? null : authoringContext;
  const onScreen = state.step === "metric" && page === 0;
  const [openRequest, setOpenRequest] = React.useState<IdeOpenRequest | null>(null);
  const openFile = React.useCallback(
    (path: string, line?: number) => setOpenRequest(line ? { path, line } : { path }),
    [],
  );
  const coding = useIdeCodingAgent({
    context: agentContext,
    active: onScreen,
    dataKnown: (authoringContext?.sample_cases?.length ?? 0) > 0 || isSingleAnswerTask(state),
    runCode: workspace.runCode,
    metricCode: workspace.metricCode,
    files: workspace.files,
    setRunCode,
    setMetricCode,
    setFile: setWorkspaceFile,
    openFile,
    lastCheck: contract.lastCheck,
    lastCheckOk,
    check: contract.check,
    guided,
  });
  // The results strip: the agent's verify_code verdict while it is newer than
  // the last Check, else that Check. Until either is fresh, a failing static
  // check (what typing just broke) wins; a result older than the files is dimmed.
  const filesKey = workspaceKey(workspace.runCode, workspace.metricCode, workspace.files);
  const verdict = coding.verdict;
  const verdictFresh = verdict?.key === filesKey;
  const staticFailed = contract.staticResult?.checks.some((item) => item.status === "failed");
  const showStatic =
    staticFailed && !verdictFresh && (verdict !== null || !contract.lastCheck || contract.stale);
  const consoleResult = showStatic ? contract.staticResult : contract.lastCheck;
  const agentResults = !showStatic && verdict ? verdict.files : null;
  const resultsStale = showStatic ? false : verdict ? !verdictFresh : contract.stale;

  const { setAgentWriting } = ctx;
  const agentBusy = coding.agent.status === "streaming";
  React.useEffect(() => {
    setAgentWriting(agentBusy);
    return () => setAgentWriting(false);
  }, [agentBusy, setAgentWriting]);

  // The sandbox still injects `llm` for old scorers; making the import
  // explicit as the user leaves the code keeps it honest about what it calls.
  const metricCode = workspace.metricCode;
  React.useEffect(() => {
    if (page === 0) return;
    const code = withScorerImports(metricCode);
    if (code !== metricCode) setMetricCode(code);
  }, [page, metricCode, setMetricCode]);

  const repoDraft = task.repo && !repoIssue(task.repo) ? task.repo : null;
  const repoName = repoDraft?.repository.trim() ?? "";
  const repoRef = repoDraft ? repoDraft.commit.trim() || repoDraft.branch.trim() : "";
  const repoFiles = React.useMemo(
    () => (repoName ? repoSource(repoName, repoRef) : null),
    [repoName, repoRef],
  );

  const hint = repo
    ? `${REPO_SCORER_SIGNATURE}  ·  ${t("submit.v2.ide.repo.read_only")}`
    : [catalog?.run_entry, metricSignature].filter(Boolean).join("  ·  ") || null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {onScreen && isGeneralistAgentEnabled() && <HideAgentPill />}
      {/* Clip, not hide: a hidden box still scrolls when the editor takes focus. */}
      <WizardScreen active={page === 0} className="flex flex-col overflow-clip">
        <IdeWorkspace
          runCode={workspace.runCode}
          metricCode={workspace.metricCode}
          files={workspace.files}
          onFileChange={setWorkspaceFile}
          onFileDelete={deleteFile}
          onCheck={repo ? null : contract.check}
          checkResult={repo ? null : consoleResult}
          agentResults={repo ? null : agentResults}
          resultsStale={!repo && resultsStale}
          hint={hint}
          repo={repoFiles}
          openRequest={openRequest}
          guided={guided}
          strip={
            metricUsesModel ? (
              <MetricModelRow
                mode={workspace.metricModelMode}
                explicitModel={workspace.metricModel}
                reflectionModel={optimizer.reflectionModel}
                onChange={patchWorkspace}
                guided={guided}
              />
            ) : null
          }
          sidePanel={
            repo ? null : (
              <CodingAgentPanel
                coding={coding}
                disabledReason={agentContext ? null : t("submit.v2.ide.agent.waiting")}
                onOpenFile={openFile}
                guided={guided}
              />
            )
          }
        />
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
