"use client";

import * as React from "react";

import { staticContractCheck, validateCode } from "@/shared/lib/api";
import { contractCheckMessage } from "@/shared/lib/i18n";
import { msg } from "@/shared/lib/messages";
import { useCodeAgent, type CodeAgentState } from "@/shared/hooks/use-code-agent";
import { autoLayoutSpec, defaultWorkflowSpec } from "@/features/submit/workflow/model";
import type { ParsedDataset } from "@/shared/lib/parse-dataset";
import type { ValidationResult } from "@/shared/ui/code-editor";
import type { ColumnMapping, ValidateCodeResponse, WorkflowSpec } from "@/shared/types/api";
import type { UnifiedAuthoringContext } from "@/shared/types/unified-run";

import type { ConfirmedDataset } from "../components/DatasetUploadCard";
import { contractValidations, panelAuthoringContext, panelContractSpec } from "../lib/code-authoring";
import type { WizardState } from "../lib/types";
import { useWizardStateOptional } from "./use-wizard-state";

// The run code and the metric are checked together by the validity check,
// once the agent settles; there is no per-editor validation outside a workflow.
const noValidation = async (): Promise<ValidationResult | null> => null;
// Code the user is typing is checked once they pause, not on every keystroke.
const EDIT_CHECK_DELAY_MS = 600;
const NO_FILES: Readonly<Record<string, string>> = {};
const NOT_WRITING_FILES: readonly string[] = [];

/**
 * The code agent's state plus the artifact fields the panel mirror renders and
 * the auto-handoff gates on. ``useCodeAgent`` keeps the code + validation in the
 * caller's own state, so this wrapper surfaces them alongside the agent state.
 */
export interface CodeAuthoringAgentState extends CodeAgentState {
  signatureCode: string;
  metricCode: string;
  signatureValidation: ValidateCodeResponse | null;
  metricValidation: ValidateCodeResponse | null;
  /** The workspace's files besides run.py and metric.py, path to text. */
  files: Readonly<Record<string, string>>;
  /**
   * True once the validity check passed for exactly the current workspace;
   * the handoff waits on it. Always false in workflow mode.
   */
  contractOk: boolean;
  /** True when run code and a metric already exist, so a new request continues from them. */
  hasCode: boolean;
  /**
   * True when the code lives in the wizard's own run-code and metric slots,
   * so the Metric step's editors show and edit it.
   */
  sharedWithWizard: boolean;
  /** True when the run targets the multi-module ``workflow`` module. */
  isWorkflow: boolean;
  /** The authored graph the inline canvas renders; null until seeded. */
  workflowSpec: WorkflowSpec | null;
  /** Bumps on external graph replacements so the canvas remounts cleanly. */
  workflowRevision: number;
  /** Node the agent just changed — the canvas pulses it briefly. */
  agentPulseNodeId: string | null;
  /** Commit a user edit from the canvas back onto the graph. */
  updateWorkflowSpec: (spec: WorkflowSpec) => void;
}

export interface UseCodeAuthoringAgentArgs {
  /** Dataset the user confirmed in-panel; supplies columns, rows, and roles. */
  dataset: ConfirmedDataset | null;
  /**
   * Whether the generalist has actually called ``request_code_authoring``.
   * Gates the code agent's own auto-seed effect so it fires on the tool call,
   * not the moment a dataset is attached.
   */
  armed: boolean;
  /**
   * The panel's wizard state: the task, data mode and optimizer the agent
   * writes run code plus a metric for.
   */
  wizard: WizardState;
  /** ``workflow`` authors a graph on the canvas instead of run code. */
  moduleName?: string;
  /** Optimizer name, forwarded to the workflow metric's validation. */
  optimizerName?: string;
  /**
   * Catalog model id + effort the code author runs on. The panel forwards the
   * conversation's chosen composer model so code authoring follows it instead
   * of always taking the server default (which auto-routes and can rate-limit).
   */
  model?: string | null;
  reasoningEffort?: string | null;
}

/** Build the validator's column mapping from the panel's role assignments. */
function rolesToColumnMapping(
  columnRoles: Record<string, "input" | "output" | "ignore">,
): ColumnMapping {
  const inputs: Record<string, string> = {};
  const outputs: Record<string, string> = {};
  for (const [col, role] of Object.entries(columnRoles)) {
    if (role === "input") inputs[col] = col;
    else if (role === "output") outputs[col] = col;
  }
  return { inputs, outputs };
}

interface AuthoringCheckArgs {
  context: UnifiedAuthoringContext | null;
  /** Identifies the context by content, so a rebuilt equal object is no change. */
  contextKey: string;
  status: CodeAgentState["status"];
  signatureCode: string;
  metricCode: string;
  files: Readonly<Record<string, string>>;
  setSignatureValidation: (result: ValidateCodeResponse | null) => void;
  setMetricValidation: (result: ValidateCodeResponse | null) => void;
}

/**
 * Run the static validity check (the same one the wizard runs before Run) on
 * the settled workspace and land its failures on the file they belong to.
 * The handoff waits on it. The coding agent checks its own code with its
 * ``verify_code`` tool and fixes what that finds inside its turn, so nothing
 * here sends a failure back to it.
 *
 * Any settled code is checked, not only what a coding turn just finished:
 * each wizard screen has its own conversation, so coming back to the Metric
 * screen resets the agent to idle while the wizard keeps its code, and an
 * edit made after that must still be checked.
 *
 * Args:
 *   args: The authoring context, the agent status, the files and the sinks.
 *
 * Returns:
 *   Whether the current workspace passed, and a reset.
 */
function useAuthoringCheck(args: AuthoringCheckArgs): { ok: boolean; reset: () => void } {
  const {
    context,
    contextKey,
    status,
    signatureCode,
    metricCode,
    files,
    setSignatureValidation,
    setMetricValidation,
  } = args;
  const [result, setResult] = React.useState<{ key: string; ok: boolean } | null>(null);
  // A reset clears the result while the code and context stay the same (each
  // wizard screen opens its own chat), so it must re-run the check itself.
  const [generation, setGeneration] = React.useState(0);
  const filesKey = JSON.stringify(files);
  const key = `${contextKey}\u0000${signatureCode}\u0000${metricCode}\u0000${filesKey}`;
  const checkable =
    context !== null && status !== "streaming" && !!signatureCode.trim() && !!metricCode.trim();
  // A finished coding turn is checked at once; typing waits for a pause.
  const delay = status === "done" ? 0 : EDIT_CHECK_DELAY_MS;

  React.useEffect(() => {
    if (!context || !checkable) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      staticContractCheck(
        {
          spec: panelContractSpec(
            context,
            signatureCode,
            metricCode,
            JSON.parse(filesKey) as Record<string, string>,
          ),
          sample_count: 1,
        },
        controller.signal,
      )
        .then((checked) => {
          if (controller.signal.aborted) return;
          const { run, metric } = contractValidations(checked, contractCheckMessage);
          setSignatureValidation(run);
          setMetricValidation(metric);
          setResult({ key, ok: checked.ok });
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          setResult({ key, ok: false });
          setSignatureValidation({
            valid: false,
            errors: [err instanceof Error ? err.message : msg("agent.validation.failed")],
            warnings: [],
          });
        });
    }, delay);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    context,
    checkable,
    signatureCode,
    metricCode,
    filesKey,
    key,
    delay,
    generation,
    setSignatureValidation,
    setMetricValidation,
  ]);

  const reset = React.useCallback(() => {
    setResult(null);
    setGeneration((g) => g + 1);
  }, []);

  return { ok: checkable && result !== null && result.key === key && result.ok, reset };
}

/**
 * Host the canonical wizard code agent (``useCodeAgent``) at the generalist
 * panel level so the panel's coding-tool steps show exactly what the code
 * agent does: the same streaming, thinking timer and authoring contract.
 *
 * On the submit wizard the code is the wizard's own: the agent writes into its
 * run-code and metric slots under the context the Metric step registers, and
 * the Metric step's editors are where the user reads and edits it. Off the
 * wizard the hook keeps the code itself and the panel hands it off once the
 * validity check passes.
 *
 * Args:
 *   args: Dataset, the ``armed`` gate, the panel's wizard state, and the
 *     optional workflow module.
 *
 * Returns:
 *   The code agent state plus the surfaced run code, metric and validation.
 */
export function useCodeAuthoringAgent(
  args: UseCodeAuthoringAgentArgs,
): CodeAuthoringAgentState {
  const { dataset, armed, wizard, moduleName = "", optimizerName, model, reasoningEffort } = args;

  const [localSignatureCode, setLocalSignatureCode] = React.useState("");
  const [localMetricCode, setLocalMetricCode] = React.useState("");
  const [localFiles, setLocalFiles] = React.useState<Readonly<Record<string, string>>>(NO_FILES);
  const [signatureManuallyEdited, setSignatureManuallyEdited] = React.useState(false);
  const [metricManuallyEdited, setMetricManuallyEdited] = React.useState(false);
  const [signatureValidation, setSignatureValidation] =
    React.useState<ValidateCodeResponse | null>(null);
  const [metricValidation, setMetricValidation] =
    React.useState<ValidateCodeResponse | null>(null);

  const columnRoles = React.useMemo(() => dataset?.columnRoles ?? {}, [dataset]);
  const columnKinds = React.useMemo(() => dataset?.columnKinds ?? {}, [dataset]);

  const isWorkflow = moduleName.toLowerCase() === "workflow";

  const wizardCtx = useWizardStateOptional();
  const wizardContext =
    !isWorkflow && wizardCtx?.wizardScreen != null ? wizardCtx.authoringContext : null;
  const shared = wizardContext !== null;
  const applyAgentPatch = wizardCtx?.applyAgentPatch;
  const signatureCode = shared ? (wizardCtx?.state.run_code ?? "") : localSignatureCode;
  const metricCode = shared ? (wizardCtx?.state.metric_code ?? "") : localMetricCode;
  const files = shared ? (wizardCtx?.workspaceFiles ?? NO_FILES) : localFiles;

  // The setters keep one identity for ``useCodeAgent`` (it captures them in
  // its run), so they read where the code lives from a ref.
  const sharedRef = React.useRef(shared);
  React.useEffect(() => {
    sharedRef.current = shared;
  });
  const writeWizardCode = wizardCtx?.writeCode;
  const writeSignatureCode = React.useCallback(
    (code: string) => {
      if (sharedRef.current && writeWizardCode?.("run", code)) return;
      if (sharedRef.current && applyAgentPatch) applyAgentPatch({ run_code: code });
      else setLocalSignatureCode(code);
    },
    [writeWizardCode, applyAgentPatch],
  );
  const writeMetricCode = React.useCallback(
    (code: string) => {
      if (sharedRef.current && writeWizardCode?.("metric", code)) return;
      if (sharedRef.current && applyAgentPatch) applyAgentPatch({ metric_code: code });
      else setLocalMetricCode(code);
    },
    [writeWizardCode, applyAgentPatch],
  );
  const writeWizardFile = wizardCtx?.writeFile;
  const setFile = React.useCallback(
    (path: string, text: string | null) => {
      if (sharedRef.current && writeWizardFile?.(path, text)) return;
      setLocalFiles((prev) => {
        if (text === null) {
          if (!(path in prev)) return prev;
          const next = { ...prev };
          delete next[path];
          return next;
        }
        return prev[path] === text ? prev : { ...prev, [path]: text };
      });
    },
    [writeWizardFile],
  );

  // A workflow run hands off a graph, never run code, so it keeps the
  // graph-aware seed and no unified context. The panel rebuilds its wizard
  // snapshot every render, so the context is keyed by content: a new object
  // with the same fields must not re-run the validity check.
  const contextKey = JSON.stringify(
    isWorkflow ? null : (wizardContext ?? panelAuthoringContext(wizard, dataset)),
  );
  // Each wizard screen opens its own chat, so coming back to the Metric screen
  // resets the coding agent while the wizard keeps its code. A seed would then
  // rewrite that code from scratch and drop the user's edits; existing code is
  // continued with a follow-up turn instead.
  const hasCode = !isWorkflow && !!signatureCode.trim() && !!metricCode.trim();
  const authoringContext = React.useMemo(
    () => JSON.parse(contextKey) as UnifiedAuthoringContext | null,
    [contextKey],
  );

  // Graph state mirrors the submit wizard's canvas ownership: the spec is the
  // single source of truth, `workflowRevision` bumps only on external replaces
  // (starter seed, agent authoring) so the canvas remounts without looping on
  // its own edits, and `workflowTouched` gates the code agent's auto-seed so a
  // user (or agent) edit is never clobbered by a re-seed.
  const [workflowSpec, setWorkflowSpec] = React.useState<WorkflowSpec | null>(null);
  const [workflowRevision, setWorkflowRevision] = React.useState(0);
  const [workflowTouched, setWorkflowTouched] = React.useState(false);
  const [agentPulseNodeId, setAgentPulseNodeId] = React.useState<string | null>(null);
  const pulseClearRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Seed a starter graph the moment the run is armed in workflow mode — the
  // code agent's workflow seed only fires once a graph exists to draft over.
  React.useEffect(() => {
    if (!armed || !isWorkflow || !dataset || workflowSpec) return;
    setWorkflowSpec(defaultWorkflowSpec(columnRoles, columnKinds));
    setWorkflowRevision((r) => r + 1);
  }, [armed, isWorkflow, dataset, workflowSpec, columnRoles, columnKinds]);

  const applyAgentWorkflow = React.useCallback(
    (spec: WorkflowSpec, changedNodeId: string | null) => {
      // Agent-authored nodes arrive without canvas positions; lay the whole
      // graph out so they never pile on top of each other.
      const laid = spec.nodes.some((n) => !n.position) ? autoLayoutSpec(spec) : spec;
      setWorkflowSpec(laid);
      setWorkflowRevision((r) => r + 1);
      setAgentPulseNodeId(changedNodeId);
      if (pulseClearRef.current) clearTimeout(pulseClearRef.current);
      if (changedNodeId) {
        pulseClearRef.current = setTimeout(() => setAgentPulseNodeId(null), 1600);
      }
    },
    [],
  );

  const updateWorkflowSpec = React.useCallback((spec: WorkflowSpec) => {
    // A user edit from the canvas: keep the spec but do NOT bump the revision
    // (the canvas already holds this state) and mark it touched so the seed
    // never overwrites the user's work.
    setWorkflowTouched(true);
    setWorkflowSpec(spec);
  }, []);

  // Gate the seed on ``armed``: until the generalist requests authoring there is
  // no dataset for the code agent, so its auto-seed effect stays dormant.
  const parsedDataset = React.useMemo<ParsedDataset | null>(() => {
    if (!armed || !dataset) return null;
    return { columns: dataset.columns, rows: dataset.rows, rowCount: dataset.rowCount };
  }, [armed, dataset]);

  // The workflow metric's runner reads live dataset/code via a ref so its
  // identity stays stable for ``useCodeAgent`` (which captures it once) while
  // still seeing the current sample row, roles, and edited code.
  const ctxRef = React.useRef({ dataset, columnRoles, optimizerName, metricCode });
  React.useEffect(() => {
    ctxRef.current = { dataset, columnRoles, optimizerName, metricCode };
  });

  const runWorkflowMetricValidation = React.useCallback(
    async (overrideCode?: string): Promise<ValidationResult | null> => {
      const { dataset: ds, columnRoles: roles, optimizerName: opt } = ctxRef.current;
      if (!ds || ds.rows.length === 0) return null;
      try {
        const result = (await validateCode({
          metric_code: overrideCode ?? ctxRef.current.metricCode,
          column_mapping: rolesToColumnMapping(roles),
          sample_row: ds.rows[0] as Record<string, unknown>,
          optimizer_name: opt,
        })) as ValidateCodeResponse;
        setMetricValidation(result);
        return result;
      } catch (err) {
        return {
          valid: false,
          errors: [err instanceof Error ? err.message : msg("agent.validation.failed")],
          warnings: [],
        };
      }
    },
    [],
  );

  // On the wizard the coding agent may sharpen the task brief, as it did in
  // the Metric step's own panel; it lands in the Task step's fields.
  const onBrief = React.useCallback(
    (brief: { objective?: string; background?: string }) => {
      if (!sharedRef.current || !applyAgentPatch) return;
      const patch: Partial<WizardState> = {};
      if (brief.objective !== undefined) patch.task_objective = brief.objective;
      if (brief.background !== undefined) patch.task_background = brief.background;
      applyAgentPatch(patch);
    },
    [applyAgentPatch],
  );

  const agent = useCodeAgent({
    columnRoles,
    columnKinds,
    parsedDataset,
    moduleName,
    signatureCode,
    metricCode,
    setSignatureCode: writeSignatureCode,
    setMetricCode: writeMetricCode,
    signatureManuallyEdited,
    metricManuallyEdited,
    setSignatureManuallyEdited,
    setMetricManuallyEdited,
    setSignatureValidation,
    setMetricValidation,
    signatureValidation,
    metricValidation,
    runSignatureValidation: noValidation,
    runMetricValidation: isWorkflow ? runWorkflowMetricValidation : noValidation,
    seedEnabled: armed && (isWorkflow || (authoringContext !== null && !hasCode)),
    unified: authoringContext,
    onBrief,
    files: files as Record<string, string>,
    setFile,
    model,
    reasoningEffort,
    isWorkflow,
    workflowSpec,
    workflowTouched,
    applyAgentWorkflow,
  });

  // The Metric step's editors show the same code, so they show it streaming.
  const setCodeWriting = wizardCtx?.setCodeWriting;
  const runWriting = shared && agent.signatureStatus === "writing";
  const metricWriting = shared && agent.metricStatus === "writing";
  const filesWriting = shared ? agent.writingFiles : NOT_WRITING_FILES;
  React.useEffect(() => {
    setCodeWriting?.({ run: runWriting, metric: metricWriting, files: filesWriting });
  }, [setCodeWriting, runWriting, metricWriting, filesWriting]);
  React.useEffect(
    () => () => setCodeWriting?.({ run: false, metric: false, files: NOT_WRITING_FILES }),
    [setCodeWriting],
  );

  const check = useAuthoringCheck({
    context: authoringContext,
    contextKey,
    status: agent.status,
    signatureCode,
    metricCode,
    files,
    setSignatureValidation,
    setMetricValidation,
  });

  // ``useCodeAgent.reset`` clears its own state but not the caller-owned code;
  // wrap it so a fresh conversation drops the previous run's artifacts too.
  // The wizard's own code stays: each wizard screen opens its own chat, and
  // leaving the Metric screen must not wipe what was written there.
  const agentReset = agent.reset;
  const checkReset = check.reset;
  const reset = React.useCallback(() => {
    agentReset();
    setLocalSignatureCode("");
    setLocalMetricCode("");
    setLocalFiles(NO_FILES);
    setSignatureValidation(null);
    setMetricValidation(null);
    checkReset();
    setSignatureManuallyEdited(false);
    setMetricManuallyEdited(false);
    setWorkflowSpec(null);
    setWorkflowRevision(0);
    setWorkflowTouched(false);
    setAgentPulseNodeId(null);
  }, [agentReset, checkReset]);

  return {
    ...agent,
    reset,
    signatureCode,
    metricCode,
    signatureValidation,
    metricValidation,
    files,
    contractOk: authoringContext !== null && check.ok,
    hasCode,
    sharedWithWizard: shared,
    isWorkflow,
    workflowSpec,
    workflowRevision,
    agentPulseNodeId,
    updateWorkflowSpec,
  };
}
