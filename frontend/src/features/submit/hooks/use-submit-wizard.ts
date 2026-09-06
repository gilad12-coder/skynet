"use client";

import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { toast } from "react-toastify";
import { track, TelemetryEvent } from "@/shared/lib/telemetry";

import {
  submitRun,
  submitGridSearch,
  type WorkflowDryRunStreamHandlers,
  validateCode,
  validateDataset,
  getExecutionRuntimes,
  getOptimizationPayload,
  getJob,
  getSharedOptimization,
  getPublicOptimization,
  stageDatasetForAgent,
  getStagedDataset,
  getDatasetRows,
  isStorageQuotaError,
  isInsufficientCreditsError,
  type DatasetSummary,
} from "@/shared/lib/api";
import type {
  ExecutionRuntime,
  ModelConfig,
  SplitFractions,
  ValidateCodeResponse,
  ValidateDatasetResponse,
  DatasetProfile,
  SplitPlan,
  RunRequest,
  GridSearchRequest,
  WorkflowSpec,
} from "@/shared/types/api";
import { parseDatasetFile, type ParsedDataset } from "@/shared/lib/parse-dataset";
import type { ValidationResult as EditorValidationResult } from "@/shared/ui/code-editor";
import { registerTutorialHook } from "@/features/tutorial";
import { formatMsg, msg } from "@/shared/lib/messages";
import { useWizardStateOptional } from "@/features/agent-panel";
import { readPref, useUserPrefs } from "@/features/settings";

import { emptyModelConfig, defaultSplit, defaultReactConfig } from "../constants";
import type { ReactConfig, ColumnRole } from "../constants";
import { LAST_WIZARD_STAGE, WIZARD_STAGE, stageAt, type WizardStageId } from "../lib/wizard-steps";
import type { WizardIssue } from "../lib/wizard-issue";
import { preflightDestination } from "../lib/preflight-destination";
import { preflightMayAdvance, preflightPendingMessageKey } from "../lib/preflight-outcome";
import { beginValidationToast, type ValidationToast } from "../lib/validation-toast";
import {
  cloneBasics,
  cloneColumnRoles,
  cloneReactToolFilter,
  cloneRows,
  cloneSourceRecipe,
} from "../lib/clone-payload";
import { buildLiveMcpToolSource } from "../lib/react-tool-filter";
import { buildSignatureTemplate } from "../lib/build-signature";
import { suggestedDspyRunName } from "../lib/budget";
import { buildMetricTemplate } from "../lib/build-metric";
import { buildOptimizerKwargs } from "../lib/build-kwargs";
import {
  projectCostBracket,
  defaultCeilingForBracket,
  chargeableBracket,
  aggregateTokenSource,
  runtimeCostProjection,
  type CostBracket,
  type ProjectedModelRole,
} from "../lib/cost-bracket";
import {
  isMeaningfulProgramDraft,
  stripModelSecrets,
  type WizardDraftData,
} from "../lib/draft-record";
import { useWizardDrafts } from "./use-wizard-drafts";
import { useExecutionBudget } from "./use-execution-budget";
import { useWizardPreflight } from "./use-wizard-preflight";
import { formatBudgetAmount } from "@/shared/lib/format-budget-amount";
import { getActiveIntlLocale } from "@/shared/lib/runtime-locale";
import type {
  ExecutionRuntimeCatalog,
  PreflightScope,
  WizardPreflightResponse,
} from "@/shared/types/wizard-preflight";
import type { MessageKey } from "@/shared/lib/generated/ui-catalog";
import { useCodeAgent } from "@/shared/hooks/use-code-agent";
import { useCodeInterview } from "@/shared/hooks/use-code-interview";
import {
  autoLayoutSpec,
  defaultWorkflowSpec,
  validateWorkflowSpec,
  workflowUsesTools,
} from "../workflow/model";
import { workflowIssueText } from "../workflow/issue-text";
import {
  buildColumnMapping,
  useDatasetProfiling,
  useModelCatalog,
  useRecentModelConfigs,
} from "./use-submit-wizard-data";

const COLUMN_ROLES = new Set<string>(["input", "output", "ignore"]);

// GEPA field defaults — the optimizer disclosure stays collapsed only while
// every field still matches them.
const DEFAULT_REFLECTION_MINIBATCH = "3";
const DEFAULT_MAX_FULL_EVALS = "6";
const DEFAULT_TARGET_SCORE = "100";
// 1x1 is GEPA's classic single-mutation sampling. Left at the default the
// wizard sends nothing, so the server-wide GEPA_PXN_* settings still apply.
const DEFAULT_PXN = "1";

export function prepareModelConfig(config: ModelConfig): ModelConfig {
  const { base_url: _baseUrl, ...fields } = config;
  const {
    api_key: _apiKey,
    api_base: _ApiBase,
    base_url: _ExtraBaseUrl,
    ...safeExtra
  } = fields.extra ?? {};
  const tokenSource = fields.token_source ?? "managed";
  return {
    ...fields,
    token_source: tokenSource,
    byok_provider: tokenSource === "byok" ? fields.byok_provider : undefined,
    extra: Object.keys(safeExtra).length > 0 ? safeExtra : undefined,
  };
}

/** Type guard for a valid dataset column role (signature I/O). */
function isColumnRole(value: unknown): value is ColumnRole {
  return typeof value === "string" && COLUMN_ROLES.has(value);
}

function parseTargetScore(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 100 ? parsed : undefined;
}

export function useSubmitWizard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session } = useSession();
  const { prefs } = useUserPrefs();
  const advancedMode = prefs.advancedMode || readPref("advancedMode");
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState(0);
  const [furthestReachedStep, setFurthestReachedStep] = useState(0);
  const [summaryTab, setSummaryTab] = useState(0);
  const [summaryCodeTab, setSummaryCodeTab] = useState<string>("signature");

  const [jobType, setOptimizationType] = useState<"run" | "grid_search">("run");
  const effectiveJobType = advancedMode ? jobType : "run";
  const [isPrivate, setIsPrivate] = useState(true);

  const username = session?.user?.name ?? "";
  const [jobName, setJobName] = useState("");
  const [jobDescription, setJobDescription] = useState("");
  const [moduleName, setModuleName] = useState("predict");
  // The code step opens on the picker and the step will not advance until a
  // module is committed — `moduleName` is only the carousel's starting slide
  // until then, never an implicit choice. While the picker is open
  // (moduleChosen=false) the editors and the agent's seed pass wait. Flows
  // that carry a decided module (draft, clone, shared state) set it chosen.
  const [moduleChosen, setModuleChosen] = useState(false);
  const [optimizerName, setOptimizerName] = useState("gepa");

  // React (ReAct-agent) tool roster. Only sent when moduleName is "react".
  // React is generic — it is scored by the same standard metric_code as
  // predict/cot, and this config only carries the live tool source.
  const executionRuntime: ExecutionRuntime = "vercel";
  const [reactConfig, setReactConfig] = useState<ReactConfig>(defaultReactConfig);
  const updateReactConfig = useCallback(
    (patch: Partial<ReactConfig>) => setReactConfig((prev) => ({ ...prev, ...patch })),
    [],
  );
  const isReact = moduleName.toLowerCase() === "react";
  const isWorkflow = moduleName.toLowerCase() === "workflow";
  const reactToolSelectionEmpty =
    Array.isArray(reactConfig.toolFilter) &&
    !reactConfig.toolFilter.some((name) => name.trim().length > 0);
  const moduleSelectionRequired = !moduleChosen;
  // Bound after the agent/interview hooks are created below; chooseModule only
  // runs on user clicks, so the refs are always populated by then.
  const agentResetRef = useRef<(() => void) | null>(null);
  const interviewResetRef = useRef<(() => void) | null>(null);
  const chooseModule = useCallback((name: string) => {
    // Picking a module restarts its setup unconditionally — even re-picking
    // the current one: a fresh agent conversation and a re-armed Signature &
    // Metric interview, so the interview re-opens and re-runs for the pick.
    // (interviewActive gates on an empty agent conversation, so the agent
    // reset is what lets the interview panel reclaim the slot.) On a first
    // pick both resets are no-ops on empty state.
    agentResetRef.current?.();
    interviewResetRef.current?.();
    setModuleName(name);
    setModuleChosen(true);
  }, []);
  const reopenModulePicker = useCallback(() => setModuleChosen(false), []);

  // Workflow graph spec — the canvas's single source of truth. `null` until
  // the user first picks the workflow module (the starter graph is seeded
  // from the dataset's column roles at that moment). `workflowRevision`
  // bumps only on external replacements (init, draft restore, clone) so the
  // canvas can remount without looping on its own edits.
  const [workflowSpec, setWorkflowSpec] = useState<WorkflowSpec | null>(null);
  const [workflowRevision, setWorkflowRevision] = useState(0);
  const workflowSpecRef = useRef<WorkflowSpec | null>(null);
  useEffect(() => {
    workflowSpecRef.current = workflowSpec;
  }, [workflowSpec]);
  // True until the user (or a restored draft/clone) touches the graph; a
  // pristine starter graph re-seeds when the dataset's column roles change,
  // an edited one is never clobbered.
  const workflowPristineRef = useRef(true);
  // Mirrors "manually edited" for the graph: gates the code agent's
  // auto-seed so it never overwrites canvas work. Agent-authored graphs do
  // NOT set it (the agent may keep iterating), but they do clear pristine.
  const [workflowTouched, setWorkflowTouched] = useState(false);
  // Node the agent just changed — the canvas pulses it briefly.
  const [agentPulseNodeId, setAgentPulseNodeId] = useState<string | null>(null);
  const pulseClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const replaceWorkflowSpec = useCallback((spec: WorkflowSpec | null) => {
    workflowSpecRef.current = spec;
    setWorkflowSpec(spec);
    setWorkflowRevision((r) => r + 1);
  }, []);
  const updateWorkflowSpec = useCallback((spec: WorkflowSpec) => {
    workflowPristineRef.current = false;
    setWorkflowTouched(true);
    workflowSpecRef.current = spec;
    setWorkflowSpec(spec);
  }, []);
  const applyAgentWorkflow = useCallback((spec: WorkflowSpec, changedNodeId: string | null) => {
    // Agent-authored nodes arrive without canvas positions; lay the whole
    // graph out so they never pile on top of each other.
    const laid = spec.nodes.some((n) => !n.position) ? autoLayoutSpec(spec) : spec;
    workflowPristineRef.current = false;
    workflowSpecRef.current = laid;
    setWorkflowSpec(laid);
    setWorkflowRevision((r) => r + 1);
    setAgentPulseNodeId(changedNodeId);
    if (pulseClearRef.current) clearTimeout(pulseClearRef.current);
    if (changedNodeId) {
      pulseClearRef.current = setTimeout(() => setAgentPulseNodeId(null), 1600);
    }
    return laid;
  }, []);

  const [signatureCode, setSignatureCode] = useState(() => buildSignatureTemplate({}));
  const [metricCode, setMetricCode] = useState(() => buildMetricTemplate({}));

  const [parsedDataset, setParsedDataset] = useState<ParsedDataset | null>(null);
  const [datasetFileName, setDatasetFileName] = useState<string | null>(null);
  // Suggested without a paid call; the name follows it until the user types one.
  const suggestedName = useMemo(
    () => suggestedDspyRunName(signatureCode, datasetFileName),
    [signatureCode, datasetFileName],
  );
  const [jobNameTouched, setJobNameTouched] = useState(false);
  useEffect(() => {
    if (!jobNameTouched) setJobName(suggestedName);
  }, [jobNameTouched, suggestedName]);
  const editJobName = useCallback((value: string) => {
    setJobNameTouched(true);
    setJobName(value);
  }, []);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // A by-reference submit (source_dataset_id) is only valid while the on-screen
  // rows are still the ones we loaded from the library. Every other dataset
  // source — upload, clone, agent-staged — replaces ``parsedDataset`` with a
  // fresh object, so this identity-bound ref naturally goes stale and the submit
  // falls back to inlining rows without clearing a flag at each call site.
  const [librarySource, setLibrarySource] = useState<{ id: string; parsed: ParsedDataset } | null>(
    null,
  );

  const [columnRoles, setColumnRoles] = useState<Record<string, ColumnRole>>({});
  // Manual override for input column modality. The dataset profiler auto-fills
  // entries for every input column (kind = "text" | "image"); the user can
  // flip a column manually via the DatasetStep toggle.
  const [columnKinds, setColumnKinds] = useState<Record<string, "text" | "image">>({});
  const hasImageInputs = Object.entries(columnKinds).some(
    ([column, kind]) => kind === "image" && columnRoles[column] === "input",
  );
  const [runtimeResult, setRuntimeResult] = useState<{
    images: boolean;
    catalog: ExecutionRuntimeCatalog | null;
  } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    getExecutionRuntimes(hasImageInputs, controller.signal)
      .then((catalog) => {
        if (!controller.signal.aborted) setRuntimeResult({ images: hasImageInputs, catalog });
      })
      .catch(() => {
        if (!controller.signal.aborted) setRuntimeResult({ images: hasImageInputs, catalog: null });
      });
    return () => controller.abort();
  }, [hasImageInputs]);
  const runtimeCatalog = runtimeResult?.images === hasImageInputs ? runtimeResult.catalog : null;
  const runtimeUnavailableReason =
    runtimeResult?.images !== hasImageInputs
      ? msg("submit.runtime.loading")
      : runtimeCatalog?.runtimes.find((runtime) => runtime.id === executionRuntime)?.available
        ? null
        : (runtimeCatalog?.runtimes.find((runtime) => runtime.id === executionRuntime)
            ?.unavailable_reason ?? msg("submit.runtime.failed"));

  const [signatureManuallyEdited, setSignatureManuallyEdited] = useState(false);
  const [metricManuallyEdited, setMetricManuallyEdited] = useState(false);
  const [codeAssistMode, setCodeAssistMode] = useState<"auto" | "manual">(() =>
    readPref("wizardCodeAssist"),
  );

  // Seed the starter graph when the workflow module is selected, and keep
  // re-seeding from the dataset's column roles for as long as the graph is
  // pristine (the module is often picked on the Basics step, before the
  // dataset exists). An edited graph is never clobbered.
  useEffect(() => {
    if (!isWorkflow) return;
    if (workflowSpecRef.current !== null && !workflowPristineRef.current) return;
    replaceWorkflowSpec(defaultWorkflowSpec(columnRoles, columnKinds));
  }, [isWorkflow, columnRoles, columnKinds, replaceWorkflowSpec]);

  // Grid search doesn't support workflow modules (backend rejects it too).
  useEffect(() => {
    if (isWorkflow && jobType !== "run") setOptimizationType("run");
  }, [isWorkflow, jobType]);

  const [modelConfig, setModelConfig] = useState<ModelConfig>(emptyModelConfig());
  const [secondModelConfig, setSecondModelConfig] = useState<ModelConfig | null>(null);

  const [editingModel, setEditingModel] = useState<{
    config: ModelConfig;
    onSave: (c: ModelConfig) => void;
    label: string;
  } | null>(null);

  const { recentConfigs, saveToRecent, clearRecentConfigs, removeRecentConfig } =
    useRecentModelConfigs();

  const catalog = useModelCatalog();

  const anyProviderHasEnvKey = catalog?.providers.some((p) => p.has_env_key) ?? false;

  const [generationModels, setGenerationModels] = useState<ModelConfig[]>([emptyModelConfig()]);
  const [reflectionModels, setReflectionModels] = useState<ModelConfig[]>([emptyModelConfig()]);

  useEffect(() => {
    if (advancedMode || jobType === "run") return;
    const firstGeneration = generationModels.find((model) => model.name.trim());
    const firstReflection = reflectionModels.find((model) => model.name.trim());
    if (firstGeneration && !modelConfig.name.trim()) {
      setModelConfig({ ...emptyModelConfig(), ...firstGeneration });
    }
    if (firstReflection && !secondModelConfig?.name?.trim()) {
      setSecondModelConfig({ ...emptyModelConfig(), ...firstReflection });
    }
    setOptimizationType("run");
  }, [
    advancedMode,
    generationModels,
    jobType,
    modelConfig.name,
    reflectionModels,
    secondModelConfig,
  ]);

  const [split, setSplit] = useState<SplitFractions>(defaultSplit);

  // Dataset profile + recommended split plan (non-blocking; the user can always
  // override or ignore). A ref mirrors the manual-edit flag so the auto-profile
  // effect can read it without stale-closure re-runs.
  const [datasetProfile, setDatasetProfile] = useState<DatasetProfile | null>(null);
  const [splitPlan, setSplitPlan] = useState<SplitPlan | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [splitMode, setSplitModeState] = useState<"auto" | "manual">(() =>
    readPref("wizardSplitMode"),
  );
  const splitModeRef = useRef<"auto" | "manual">(readPref("wizardSplitMode"));

  // Mirror live pref changes into local wizard state so changes the user
  // makes in the settings modal while the wizard is mounted take effect
  // without a remount. Skip the first run because UserPrefsProvider boots
  // with DEFAULT_PREFS and hydrates from localStorage in a useEffect — our
  // useState initializers above already used readPref() (sync), so the first
  // render's `prefs.*` values would clobber them with defaults.
  const codeAssistFirstRunRef = useRef(true);
  useEffect(() => {
    if (codeAssistFirstRunRef.current) {
      codeAssistFirstRunRef.current = false;
      return;
    }
    setCodeAssistMode(prefs.wizardCodeAssist);
  }, [prefs.wizardCodeAssist]);

  const splitModeFirstRunRef = useRef(true);
  useEffect(() => {
    if (splitModeFirstRunRef.current) {
      splitModeFirstRunRef.current = false;
      return;
    }
    splitModeRef.current = prefs.wizardSplitMode;
    setSplitModeState(prefs.wizardSplitMode);
  }, [prefs.wizardSplitMode]);

  const [seed, setSeed] = useState<number | undefined>(undefined);

  const [signatureValidation, setSignatureValidation] = useState<ValidateCodeResponse | null>(null);
  const [metricValidation, setMetricValidation] = useState<ValidateCodeResponse | null>(null);
  const [datasetValidation, setDatasetValidation] = useState<ValidateDatasetResponse | null>(null);

  const [autoLevel, setAutoLevel] = useState<string>("light");
  const [reflectionMinibatchSize, setReflectionMinibatchSize] = useState<string>(
    DEFAULT_REFLECTION_MINIBATCH,
  );
  const [maxFullEvals, setMaxFullEvals] = useState<string>(DEFAULT_MAX_FULL_EVALS);
  // Explicit GEPA metric-call (rollout) budget. Opt-in and empty by default —
  // when set it outranks maxFullEvals in buildOptimizerKwargs, since that
  // field always carries its default.
  const [maxMetricCalls, setMaxMetricCalls] = useState<string>("");
  const [useMerge, setUseMerge] = useState(true);
  const [targetScore, setTargetScore] = useState<string>(DEFAULT_TARGET_SCORE);
  const [pxnParents, setPxnParents] = useState<string>(DEFAULT_PXN);
  const [pxnProposals, setPxnProposals] = useState<string>(DEFAULT_PXN);

  // Disclosure state for the advanced wizard sections (Basics: optimization
  // type, Params: optimizer settings). Held here rather than in the step
  // components so the deep-dive tour can open the sections through the
  // bridge, and so a restored non-default value surfaces itself instead of
  // hiding behind a collapsed row. Opening is one-way: nothing auto-closes.
  const [optimizationTypeOpen, setOptimizationTypeOpen] = useState(false);
  const [optimizerSettingsOpen, setOptimizerSettingsOpen] = useState(false);
  useEffect(() => {
    if (prefs.expandAdvanced && advancedMode) {
      setOptimizationTypeOpen(true);
      setOptimizerSettingsOpen(true);
    }
  }, [advancedMode, prefs.expandAdvanced]);
  useEffect(() => {
    if (advancedMode && jobType !== "run") setOptimizationTypeOpen(true);
  }, [advancedMode, jobType]);
  useEffect(() => {
    if (!advancedMode) return;
    if (
      reflectionMinibatchSize !== DEFAULT_REFLECTION_MINIBATCH ||
      maxFullEvals !== DEFAULT_MAX_FULL_EVALS ||
      maxMetricCalls !== "" ||
      !useMerge ||
      targetScore !== DEFAULT_TARGET_SCORE ||
      pxnParents !== DEFAULT_PXN ||
      pxnProposals !== DEFAULT_PXN
    ) {
      setOptimizerSettingsOpen(true);
    }
  }, [
    advancedMode,
    reflectionMinibatchSize,
    maxFullEvals,
    maxMetricCalls,
    useMerge,
    targetScore,
    pxnParents,
    pxnProposals,
  ]);
  const [shuffle, setShuffle] = useState(true);
  // One shared total follows both workflow forms; the server owns spending and reservations.
  const {
    maxCostCredits,
    setMaxCostCredits,
    budgetUncapped,
    setBudgetUncapped,
    session: budgetSession,
    setupSpent,
    availableCredits,
  } = useExecutionBudget();

  const [submitting, setSubmitting] = useState(false);
  const [submitPhase, setSubmitPhase] = useState<"idle" | "sending" | "splash" | "done">("idle");

  // Guard against double-clicks on the Next button while the code-step
  // validation network call is in flight (~5s). Without this, two
  // sequential `setStep((s) => s + 1)` calls advance the wizard twice.
  const [advancing, setAdvancing] = useState(false);
  const advancingRef = useRef(false);
  const validationAttemptRef = useRef(0);
  const navigationRevisionRef = useRef(0);
  const validationToastRef = useRef<ValidationToast | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      navigationRevisionRef.current += 1;
      validationToastRef.current?.dismiss();
    };
  }, []);

  // Storing the in-flight promise itself also dedupes
  // concurrent calls against the same key — useful when both signature and
  // metric run in parallel and one is re-triggered before the other lands.
  const validationCacheRef = useRef(new Map<string, Promise<ValidateCodeResponse>>());

  const [cloneLoading, setCloneLoading] = useState(false);
  const [issue, setIssue] = useState<WizardIssue | null>(null);
  const cloneRan = useRef(false);

  // Register setters with the typed tutorial bridge so the tutorial system
  // can drive the wizard from plain-JS steps (see lib/tutorial-bridge.ts).
  useEffect(() => {
    const unregister = [
      registerTutorialHook("setWizardStep", setStep),
      registerTutorialHook("setParsedDataset", setParsedDataset),
      registerTutorialHook("setColumnRoles", setColumnRoles),
      registerTutorialHook("setDatasetFileName", setDatasetFileName),
      registerTutorialHook("chooseModule", chooseModule),
      registerTutorialHook("reopenModulePicker", reopenModulePicker),
      registerTutorialHook("setCodeAssistMode", setCodeAssistMode),
      registerTutorialHook("setModelConfigOpen", (open) => {
        setEditingModel(
          open
            ? {
                config: modelConfig,
                onSave: setModelConfig,
                label: msg("model.generation.label"),
              }
            : null,
        );
      }),
      registerTutorialHook("setSignatureCode", (code) => {
        setSignatureCode(code);
        setSignatureManuallyEdited(true);
      }),
      registerTutorialHook("setMetricCode", (code) => {
        setMetricCode(code);
        setMetricManuallyEdited(true);
      }),
      registerTutorialHook("setOptimizerName", setOptimizerName),
      registerTutorialHook("setAdvancedSectionsOpen", (open) => {
        setOptimizationTypeOpen(open);
        setOptimizerSettingsOpen(open);
      }),
    ];
    return () => unregister.forEach((fn) => fn());
  }, []);

  // Shared wizard-state bridge: the generalist agent writes wizard fields
  // into WizardStateContext. We mirror those agent writes into the local
  // wizard state, and push local edits back so the agent's phased-exposure
  // gate sees them. Echo is avoided by only pushing when the value actually
  // differs from shared.
  const wizardCtx = useWizardStateOptional();
  const { agentPulseTick, agentPulseKeys, sharedState } = {
    agentPulseTick: wizardCtx?.agentPulseTick ?? 0,
    agentPulseKeys: wizardCtx?.agentPulseKeys ?? [],
    sharedState: wizardCtx?.state,
  };

  // After a successful submit, navigation unmounts this form. Clear the shared
  // wizard state on that unmount so a later agent turn doesn't inherit the
  // just-submitted run's readiness + staged dataset and offer a duplicate.
  // Gated on ``submittedRef`` so merely navigating away from a half-filled
  // wizard preserves the in-progress state. Deferred to unmount (rather than
  // run inline in handleSubmit) so the outgoing sync effects below can't
  // re-push the stale values back into the context after the reset.
  const wizardCtxRef = useRef(wizardCtx);
  useEffect(() => {
    wizardCtxRef.current = wizardCtx;
  }, [wizardCtx]);
  const submittedRef = useRef(false);

  const drafts = useWizardDrafts();
  const draftsRef = useRef(drafts);
  useEffect(() => {
    draftsRef.current = drafts;
  }, [drafts]);
  // Taken once at mount: the saved draft this instance hydrates from, or null
  // when the form starts blank. Publishing waits until that hydration has
  // landed so the first snapshot written is the restored one, not the empty
  // initial state.
  const [draftSnapshot] = useState(() => drafts.takeSnapshot("program"));
  const hydratedRef = useRef(false);
  // The draft never carries credentials: a restored BYOK model comes back
  // without its key and shows as missing credentials.
  const safeReactConfig = useMemo(() => ({ ...reactConfig, mcpAuthHeader: "" }), [reactConfig]);
  const safeModelConfig = useMemo(() => stripModelSecrets(modelConfig), [modelConfig]);
  const safeSecondModelConfig = useMemo(
    () => (secondModelConfig ? stripModelSecrets(secondModelConfig) : null),
    [secondModelConfig],
  );
  const safeGenerationModels = useMemo(
    () => generationModels.map(stripModelSecrets),
    [generationModels],
  );
  const safeReflectionModels = useMemo(
    () => reflectionModels.map(stripModelSecrets),
    [reflectionModels],
  );

  // Mirror the full serializable wizard snapshot into a ref every commit and
  // hand it to the draft saver, which debounces and dedupes the writes.
  const draftRef = useRef<WizardDraftData | null>(null);
  useEffect(() => {
    draftRef.current = {
      stage: stageAt(step),
      furthestStage: stageAt(furthestReachedStep),
      summaryTab,
      summaryCodeTab,
      jobType: effectiveJobType,
      isPrivate,
      jobName,
      jobDescription,
      moduleName,
      moduleChosen,
      optimizerName,
      executionRuntime,
      codeAssistMode,
      splitMode,
      reactConfig: safeReactConfig,
      workflowSpec,
      signatureCode,
      metricCode,
      signatureManuallyEdited,
      metricManuallyEdited,
      parsedDataset,
      datasetFileName,
      columnRoles,
      columnKinds,
      modelConfig: safeModelConfig,
      secondModelConfig: safeSecondModelConfig,
      generationModels: safeGenerationModels,
      reflectionModels: safeReflectionModels,
      split,
      seed,
      autoLevel,
      reflectionMinibatchSize,
      maxFullEvals,
      maxMetricCalls,
      useMerge,
      targetScore,
      pxnParents,
      pxnProposals,
      shuffle,
      maxCostCredits,
    };
    // A submit that has left is not re-parked while its splash plays out.
    if (hydratedRef.current && !submittedRef.current) {
      const d = draftRef.current;
      draftsRef.current.publish("program", d, isMeaningfulProgramDraft(d));
    }
  });
  // Stage boundaries are the one place the debounce is skipped: a refresh right
  // after Next lands on the stage the user just reached.
  useEffect(() => {
    if (hydratedRef.current) draftsRef.current.flush();
  }, [step]);

  // Hydrate once from the draft this instance was handed (Continue, a locale
  // reload) so the user lands on the same step with inputs intact. A blank
  // start leaves a clone/share URL to populate the form itself.
  const restoredRef = useRef(false);
  // The draft's stage is applied one render after its fields, so the
  // prerequisite walk (below validateStep) checks the restored state rather
  // than the empty initial one.
  const [pendingRestore, setPendingRestore] = useState<{
    stage: WizardStageId;
    furthest: WizardStageId;
  } | null>(null);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const d = draftSnapshot;
    if (!d) {
      hydratedRef.current = true;
      return;
    }
    setPendingRestore({ stage: d.stage, furthest: d.furthestStage });
    setSummaryTab(d.summaryTab);
    setSummaryCodeTab(d.summaryCodeTab);
    setOptimizationType(advancedMode ? d.jobType : "run");
    setIsPrivate(d.isPrivate);
    setJobName(d.jobName);
    setJobNameTouched(
      d.jobName.trim() !== "" &&
        d.jobName !== suggestedDspyRunName(d.signatureCode, d.datasetFileName),
    );
    setJobDescription(d.jobDescription);
    setModuleName(d.moduleName);
    setModuleChosen(d.moduleChosen);
    setOptimizerName(d.optimizerName);
    setCodeAssistMode(d.codeAssistMode ?? "manual");
    splitModeRef.current = d.splitMode ?? "manual";
    setSplitModeState(d.splitMode ?? "manual");
    setReactConfig({ ...d.reactConfig, mcpAuthHeader: "" });
    if (d.workflowSpec) {
      replaceWorkflowSpec(d.workflowSpec);
      workflowPristineRef.current = false;
      setWorkflowTouched(true);
    }
    setSignatureCode(d.signatureCode);
    setMetricCode(d.metricCode);
    setSignatureManuallyEdited(d.signatureManuallyEdited || !!d.signatureCode.trim());
    setMetricManuallyEdited(d.metricManuallyEdited || !!d.metricCode.trim());
    setSignatureValidation(null);
    setMetricValidation(null);
    setDatasetValidation(null);
    validationCacheRef.current.clear();
    setParsedDataset(d.parsedDataset);
    setDatasetFileName(d.datasetFileName);
    setColumnRoles(d.columnRoles);
    setColumnKinds(d.columnKinds);
    setModelConfig(d.modelConfig);
    setSecondModelConfig(d.secondModelConfig);
    setGenerationModels(d.generationModels);
    setReflectionModels(d.reflectionModels);
    setSplit(d.split);
    setSeed(d.seed);
    setAutoLevel(d.autoLevel);
    setReflectionMinibatchSize(d.reflectionMinibatchSize);
    setMaxFullEvals(d.maxFullEvals);
    setMaxMetricCalls(d.maxMetricCalls ?? "");
    setUseMerge(d.useMerge);
    setTargetScore(d.targetScore?.trim() ? d.targetScore : DEFAULT_TARGET_SCORE);
    setPxnParents(d.pxnParents ?? DEFAULT_PXN);
    setPxnProposals(d.pxnProposals ?? DEFAULT_PXN);
    setShuffle(d.shuffle);

    if (!advancedMode && d.jobType === "grid_search") {
      const firstGeneration = d.generationModels.find((model) => model.name.trim());
      const firstReflection = d.reflectionModels.find((model) => model.name.trim());
      if (firstGeneration) setModelConfig({ ...emptyModelConfig(), ...firstGeneration });
      if (firstReflection) setSecondModelConfig({ ...emptyModelConfig(), ...firstReflection });
    }
    hydratedRef.current = true;
  }, [advancedMode]);

  useEffect(
    () => () => {
      if (submittedRef.current) {
        // A submit leaves on purpose: reset the shared agent state; the draft
        // was already consumed when the job was accepted.
        wizardCtxRef.current?.reset();
        return;
      }
      // Leaving mid-setup keeps the draft: write whatever the debounce still holds.
      draftsRef.current.flush();
    },
    [],
  );

  // The agent's graph as seated on the canvas; the outgoing push skips it so
  // a layout-only copy is never echoed back as a user override.
  const agentWorkflowRef = useRef<WorkflowSpec | null>(null);
  // Incoming: apply agent patches to local state whenever the pulse bumps.
  useEffect(() => {
    if (!sharedState || agentPulseKeys.length === 0) return;
    for (const key of agentPulseKeys) {
      if (key === "job_name" && typeof sharedState.job_name === "string") {
        // An agent-given name is decided: the form's own suggestion must not
        // overwrite it when the code or dataset changes later.
        setJobName(sharedState.job_name);
        setJobNameTouched(true);
      } else if (key === "job_description" && typeof sharedState.job_description === "string") {
        setJobDescription(sharedState.job_description);
      } else if (
        key === "job_type" &&
        (sharedState.job_type === "run" || sharedState.job_type === "grid_search")
      ) {
        setOptimizationType(
          sharedState.job_type === "grid_search" && !advancedMode ? "run" : sharedState.job_type,
        );
      } else if (key === "optimizer_name" && typeof sharedState.optimizer_name === "string") {
        setOptimizerName(sharedState.optimizer_name);
      } else if (key === "module_name" && typeof sharedState.module_name === "string") {
        setModuleName(sharedState.module_name);
        setModuleChosen(true);
      } else if (key === "react_config" && sharedState.react_config) {
        const rc = sharedState.react_config as Record<string, unknown>;
        setReactConfig((prev) => {
          const next = { ...prev };
          if (typeof rc.mcpUrl === "string") next.mcpUrl = rc.mcpUrl;
          if (rc.toolFilter === null) {
            next.toolFilter = null;
          } else if (Array.isArray(rc.toolFilter)) {
            next.toolFilter = rc.toolFilter.filter(
              (name): name is string => typeof name === "string",
            );
          }
          return next;
        });
      } else if (key === "signature_code" && typeof sharedState.signature_code === "string") {
        // Agent-authored code is written for the module already in play (the
        // predict default when none was named), so the picker never re-asks.
        setSignatureCode(sharedState.signature_code);
        setSignatureManuallyEdited(true);
        setSignatureValidation(null);
        setModuleChosen(true);
      } else if (key === "metric_code" && typeof sharedState.metric_code === "string") {
        setMetricCode(sharedState.metric_code);
        setMetricManuallyEdited(true);
        setMetricValidation(null);
        setModuleChosen(true);
      } else if (key === "workflow" && sharedState.workflow) {
        // A panel-authored graph is the program: seat it on the canvas as the
        // workflow module instead of dropping it on the floor.
        setModuleName("workflow");
        setModuleChosen(true);
        const laid = applyAgentWorkflow(sharedState.workflow, null);
        agentWorkflowRef.current = laid;
      } else if (key === "column_roles" && sharedState.column_roles) {
        setColumnRoles((prev) => {
          const next = { ...prev };
          for (const [col, role] of Object.entries(sharedState.column_roles ?? {})) {
            if (isColumnRole(role)) next[col] = role;
          }
          return next;
        });
      } else if (key === "model_config" && sharedState.model_config) {
        setModelConfig({
          ...emptyModelConfig(),
          ...(sharedState.model_config as Partial<ModelConfig>),
        });
      } else if (key === "reflection_model_config" && sharedState.reflection_model_config) {
        setSecondModelConfig({
          ...emptyModelConfig(),
          ...(sharedState.reflection_model_config as Partial<ModelConfig>),
        });
      } else if (key === "generation_models" && Array.isArray(sharedState.generation_models)) {
        setGenerationModels(
          sharedState.generation_models.map((m) => ({
            ...emptyModelConfig(),
            ...(m as Partial<ModelConfig>),
          })),
        );
      } else if (key === "reflection_models" && Array.isArray(sharedState.reflection_models)) {
        setReflectionModels(
          sharedState.reflection_models.map((m) => ({
            ...emptyModelConfig(),
            ...(m as Partial<ModelConfig>),
          })),
        );
      } else if (key === "split_fractions" && sharedState.split_fractions) {
        setSplit(sharedState.split_fractions);
      } else if (
        key === "split_mode" &&
        (sharedState.split_mode === "auto" || sharedState.split_mode === "manual")
      ) {
        splitModeRef.current = sharedState.split_mode;
        setSplitModeState(sharedState.split_mode);
      } else if (key === "seed" && typeof sharedState.seed === "number") {
        setSeed(sharedState.seed);
      } else if (key === "shuffle" && typeof sharedState.shuffle === "boolean") {
        setShuffle(sharedState.shuffle);
      } else if (key === "is_private" && typeof sharedState.is_private === "boolean") {
        setIsPrivate(sharedState.is_private);
      } else if (key === "optimizer_kwargs" && sharedState.optimizer_kwargs) {
        const kw = sharedState.optimizer_kwargs as Record<string, unknown>;
        // GEPA takes exactly one of auto/max_full_evals/max_metric_calls; an
        // explicit budget without an auto tier must also clear the tier, or
        // the "light" default would win the rebuild and drop the budget.
        if (typeof kw.auto === "string") {
          setAutoLevel(kw.auto);
        } else if (kw.max_full_evals != null || kw.max_metric_calls != null) {
          setAutoLevel("");
        }
        if (typeof kw.reflection_minibatch_size === "number") {
          setReflectionMinibatchSize(String(kw.reflection_minibatch_size));
        }
        if (typeof kw.max_full_evals === "number") {
          setMaxFullEvals(String(kw.max_full_evals));
        }
        if (typeof kw.max_metric_calls === "number") {
          setMaxMetricCalls(String(kw.max_metric_calls));
        }
        if (typeof kw.use_merge === "boolean") setUseMerge(kw.use_merge);
      } else if (key === "target_score") {
        if (typeof sharedState.target_score === "number") {
          setTargetScore(String(sharedState.target_score));
        } else if (sharedState.target_score == null) {
          setTargetScore(DEFAULT_TARGET_SCORE);
        }
      }
    }
  }, [advancedMode, agentPulseTick]);

  // Outgoing: push relevant local state back into the shared context so the
  // agent's tool-gate (dataset_ready, columns_configured, model_configured)
  // reflects what the user actually has. Guarded by value equality to avoid
  // echo after incoming patches.
  useEffect(() => {
    if (!wizardCtx) return;
    const datasetReady = !!parsedDataset && parsedDataset.rowCount > 0;
    if (wizardCtx.state.dataset_ready !== datasetReady) {
      wizardCtx.setField("dataset_ready", datasetReady, "user");
    }
    const columns = parsedDataset?.columns ?? [];
    const shared = wizardCtx.state.dataset_columns;
    const changed =
      !shared || shared.length !== columns.length || columns.some((c, i) => shared[i] !== c);
    if (changed && columns.length > 0) {
      wizardCtx.setField("dataset_columns", columns, "user");
    }
  }, [parsedDataset, wizardCtx]);

  const estimateModelConfigs =
    effectiveJobType === "run"
      ? [
          modelConfig,
          ...(optimizerName.toLowerCase() === "gepa" && secondModelConfig?.name?.trim()
            ? [secondModelConfig]
            : []),
        ]
      : [...generationModels, ...reflectionModels];
  const estimateTokenSource = aggregateTokenSource(estimateModelConfigs);

  // Projected pre-run credit bracket [FG-1]: a DSPy job's token use isn't linear,
  // so we show a range rather than a false-precision single number and seed the
  // Max Cost Ceiling from its high end. For a grid, count the (gen × refl) pairs
  // so the bracket reflects the whole sweep.
  const costBracket: CostBracket = useMemo(() => {
    const findModel = (config: ModelConfig) =>
      config.name.trim()
        ? (catalog?.models.find((candidate) => candidate.value === config.name) ?? null)
        : null;
    let modelRoles: ProjectedModelRole[];
    if (effectiveJobType === "grid_search") {
      const tasks = generationModels.filter((config) => config.name.trim());
      const optimizers = reflectionModels.filter((config) => config.name.trim());
      modelRoles = [
        ...tasks.map((config) => ({
          role: "task" as const,
          model: findModel(config),
          tokenSource: config.token_source ?? "managed",
          tokenShare: (1 - 0.35) * Math.max(1, optimizers.length),
        })),
        ...optimizers.map((config) => ({
          role: "optimization" as const,
          model: findModel(config),
          tokenSource: config.token_source ?? "managed",
          tokenShare: 0.35 * Math.max(1, tasks.length),
        })),
      ];
    } else {
      const optimization =
        optimizerName.toLowerCase() === "gepa" && secondModelConfig?.name.trim()
          ? secondModelConfig
          : null;
      modelRoles = [
        {
          role: "task",
          model: findModel(modelConfig),
          tokenSource: modelConfig.token_source ?? "managed",
          tokenShare: optimization ? 1 - 0.35 : 1,
        },
        ...(optimization
          ? [
              {
                role: "optimization" as const,
                model: findModel(optimization),
                tokenSource: optimization.token_source ?? "managed",
                tokenShare: 0.35,
              },
            ]
          : []),
      ];
    }
    const selectedRuntime = runtimeCatalog?.runtimes.find(
      (runtime) => runtime.id === executionRuntime,
    );
    // The final setup check and submitted run use separate metered sessions.
    return projectCostBracket({
      autoLevel,
      maxFullEvals: advancedMode ? maxFullEvals : DEFAULT_MAX_FULL_EVALS,
      maxMetricCalls: advancedMode ? maxMetricCalls : "",
      datasetRows: parsedDataset?.rowCount ?? 0,
      modelRoles,
      runtime: runtimeCostProjection(selectedRuntime?.cost, 2),
    });
  }, [
    autoLevel,
    advancedMode,
    maxFullEvals,
    maxMetricCalls,
    parsedDataset?.rowCount,
    effectiveJobType,
    modelConfig.name,
    modelConfig.token_source,
    secondModelConfig,
    generationModels,
    reflectionModels,
    catalog,
    optimizerName,
    runtimeCatalog,
  ]);

  // Default the cap to the bracket's high end (with headroom) the first time a
  // user opens the ceiling control; once they set a value we leave it alone.
  const suggestedCeiling = useMemo(
    () => defaultCeilingForBracket(chargeableBracket(costBracket, estimateTokenSource)),
    [costBracket, estimateTokenSource],
  );

  // Stage the parsed rows on the backend so the agent can submit by id
  // without inlining tens of thousands of rows into its tool arguments.
  // Re-runs whenever the user uploads a new file or clones a different
  // job; identity-equality on ``parsedDataset`` is enough — every parse
  // path replaces the object.
  const lastStagedDatasetRef = useRef<ParsedDataset | null>(null);
  // Staged id that the current ``parsedDataset`` already corresponds to —
  // set when this wizard stages its own upload, or when it hydrates a dataset
  // the chat staged. Lets the incoming hydration effect below skip a dataset
  // we're already showing, and stops the outgoing effect from re-staging
  // (which would mint a *different* id for identical rows and ping-pong the
  // shared context against the panel).
  const parsedDatasetStagedIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!wizardCtx) return;
    if (!parsedDataset || parsedDataset.rowCount === 0) {
      if (wizardCtx.state.staged_dataset_id !== undefined) {
        wizardCtx.clearField("staged_dataset_id");
      }
      lastStagedDatasetRef.current = null;
      parsedDatasetStagedIdRef.current = null;
      return;
    }
    if (lastStagedDatasetRef.current === parsedDataset) return;
    lastStagedDatasetRef.current = parsedDataset;
    let cancelled = false;
    stageDatasetForAgent({
      dataset: parsedDataset.rows as Array<Record<string, unknown>>,
      dataset_filename: datasetFileName || "dataset.json",
    })
      .then((res) => {
        if (cancelled) return;
        if (lastStagedDatasetRef.current !== parsedDataset) return;
        parsedDatasetStagedIdRef.current = res.staged_dataset_id;
        wizardCtx.setField("staged_dataset_id", res.staged_dataset_id, "user");
      })
      .catch(() => {
        if (cancelled) return;
        if (lastStagedDatasetRef.current === parsedDataset) {
          lastStagedDatasetRef.current = null;
        }
      });
    return () => {
      cancelled = true;
    };
  }, [parsedDataset, datasetFileName, wizardCtx]);

  // Incoming (chat → wizard): when the shared context points at a staged
  // dataset this wizard isn't already showing — e.g. the user attached a file
  // in the agent panel — fetch those exact rows and mirror them here. The
  // shared context survives client-side navigation (it lives in the app shell),
  // so this reliably rehydrates whether the wizard was already mounted or the
  // user navigated to /submit afterwards, with no dependence on sessionStorage.
  const hydratingStagedIdRef = useRef<string | null>(null);
  const sharedStagedId = sharedState?.staged_dataset_id;
  useEffect(() => {
    if (!wizardCtx) return;
    if (typeof sharedStagedId !== "string" || !sharedStagedId) return;
    if (sharedStagedId === parsedDatasetStagedIdRef.current) return;
    if (sharedStagedId === hydratingStagedIdRef.current) return;
    hydratingStagedIdRef.current = sharedStagedId;
    let cancelled = false;
    getStagedDataset(sharedStagedId)
      .then((res) => {
        if (cancelled || !res || res.rows.length === 0) return;
        const hydrated: ParsedDataset = {
          columns: res.columns.length > 0 ? res.columns : Object.keys(res.rows[0] ?? {}),
          rows: res.rows,
          rowCount: res.row_count,
        };
        // Mark the rows as already-staged under this id BEFORE setting them so
        // the outgoing staging effect early-returns instead of re-staging.
        parsedDatasetStagedIdRef.current = sharedStagedId;
        lastStagedDatasetRef.current = hydrated;
        setParsedDataset(hydrated);
        setDatasetFileName((prev) => prev ?? "dataset.json");
        setDatasetProfile(null);
        setSplitPlan(null);
        // The agent staged this dataset, so it owns code authoring for the
        // session (via request_code_authoring in the panel). Mark code as
        // already-authored so the wizard's own useCodeAgent auto-seed stands
        // down instead of authoring a second, racing Signature/Metric. The
        // agent's authored code then arrives as an applyAgentPatch.
        setSignatureManuallyEdited(true);
        setMetricManuallyEdited(true);
        const roles = wizardCtx.state.column_roles;
        if (roles && typeof roles === "object") {
          const next: Record<string, "input" | "output" | "ignore"> = {};
          for (const [col, role] of Object.entries(roles)) {
            if (role === "input" || role === "output" || role === "ignore") next[col] = role;
          }
          if (Object.keys(next).length > 0) setColumnRoles(next);
        }
      })
      .catch(() => {
        /* best-effort: a failed fetch leaves the wizard's own dataset intact */
      })
      .finally(() => {
        if (!cancelled && hydratingStagedIdRef.current === sharedStagedId) {
          hydratingStagedIdRef.current = null;
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sharedStagedId, wizardCtx]);

  useEffect(() => {
    if (!wizardCtx) return;
    if (wizardCtx.state.job_name !== jobName) {
      wizardCtx.setField("job_name", jobName, "user");
    }
  }, [jobName, wizardCtx]);

  // The canvas is the program for a workflow run: the agent submits what it
  // sees here, so canvas edits reach it and a non-workflow module clears it.
  useEffect(() => {
    if (!wizardCtx) return;
    const spec = isWorkflow ? workflowSpec : null;
    if (spec) {
      if (spec !== agentWorkflowRef.current && wizardCtx.state.workflow !== spec) {
        wizardCtx.setField("workflow", spec, "user");
      }
    } else if (wizardCtx.state.workflow != null) {
      wizardCtx.clearField("workflow");
    }
  }, [isWorkflow, wizardCtx, workflowSpec]);

  useEffect(() => {
    if (!wizardCtx) return;
    if (wizardCtx.state.signature_code !== signatureCode) {
      wizardCtx.setField("signature_code", signatureCode, "user");
    }
  }, [signatureCode, wizardCtx]);

  useEffect(() => {
    if (!wizardCtx) return;
    if (wizardCtx.state.metric_code !== metricCode) {
      wizardCtx.setField("metric_code", metricCode, "user");
    }
  }, [metricCode, wizardCtx]);

  useEffect(() => {
    if (!wizardCtx) return;
    const inputs = Object.values(columnRoles).filter((r) => r === "input").length;
    const outputs = Object.values(columnRoles).filter((r) => r === "output").length;
    const configured = inputs > 0 && outputs > 0;
    if (wizardCtx.state.columns_configured !== configured) {
      wizardCtx.setField("columns_configured", configured, "user");
    }
    const shared = wizardCtx.state.column_roles ?? {};
    const sameShape =
      Object.keys(shared).length === Object.keys(columnRoles).length &&
      Object.entries(columnRoles).every(([c, r]) => shared[c] === r);
    if (!sameShape && Object.keys(columnRoles).length > 0) {
      wizardCtx.setField("column_roles", columnRoles, "user");
    }
  }, [columnRoles, wizardCtx]);

  useEffect(() => {
    if (!wizardCtx) return;
    const configured = !!modelConfig.name.trim();
    if (wizardCtx.state.model_configured !== configured) {
      wizardCtx.setField("model_configured", configured, "user");
    }
    wizardCtx.setField("model_config", modelConfig as unknown as Record<string, unknown>, "user");
  }, [modelConfig, wizardCtx]);

  // Outgoing: scalar wizard fields the agent can read back for decisions.
  useEffect(() => {
    if (!wizardCtx) return;
    const s = wizardCtx.state;
    if (s.job_description !== jobDescription) {
      wizardCtx.setField("job_description", jobDescription, "user");
    }
    if (s.job_type !== effectiveJobType) {
      wizardCtx.setField("job_type", effectiveJobType, "user");
    }
    if (s.optimizer_name !== optimizerName) {
      wizardCtx.setField("optimizer_name", optimizerName, "user");
    }
    if (s.module_name !== moduleName) {
      wizardCtx.setField("module_name", moduleName, "user");
    }
    if (s.split_mode !== splitMode) {
      wizardCtx.setField("split_mode", splitMode, "user");
    }
    if (s.seed !== seed) {
      wizardCtx.setField("seed", seed, "user");
    }
    if (s.shuffle !== shuffle) {
      wizardCtx.setField("shuffle", shuffle, "user");
    }
    if (s.is_private !== isPrivate) {
      wizardCtx.setField("is_private", isPrivate, "user");
    }
    const parsedTargetScore =
      advancedMode && optimizerName.toLowerCase() === "gepa"
        ? parseTargetScore(targetScore)
        : undefined;
    if (s.target_score !== parsedTargetScore) {
      wizardCtx.setField("target_score", parsedTargetScore, "user");
    }
  }, [
    jobDescription,
    effectiveJobType,
    optimizerName,
    moduleName,
    splitMode,
    seed,
    shuffle,
    isPrivate,
    advancedMode,
    targetScore,
    wizardCtx,
  ]);

  // Outgoing: split fractions (compared component-wise to avoid object echo).
  useEffect(() => {
    if (!wizardCtx) return;
    const shared = wizardCtx.state.split_fractions;
    if (
      !shared ||
      shared.train !== split.train ||
      shared.val !== split.val ||
      shared.test !== split.test
    ) {
      wizardCtx.setField("split_fractions", split, "user");
    }
  }, [split, wizardCtx]);

  // Outgoing: object/array fields — setField's internal ref-dedupe keeps these cheap.
  useEffect(() => {
    if (!wizardCtx) return;
    wizardCtx.setField(
      "reflection_model_config",
      (secondModelConfig ?? undefined) as Record<string, unknown> | undefined,
      "user",
    );
  }, [secondModelConfig, wizardCtx]);

  useEffect(() => {
    if (!wizardCtx) return;
    wizardCtx.setField(
      "generation_models",
      generationModels as unknown as Array<Record<string, unknown>>,
      "user",
    );
  }, [generationModels, wizardCtx]);

  useEffect(() => {
    if (!wizardCtx) return;
    wizardCtx.setField(
      "reflection_models",
      reflectionModels as unknown as Array<Record<string, unknown>>,
      "user",
    );
  }, [reflectionModels, wizardCtx]);

  // Outgoing: react config (minus the secret mcp_auth_header) so the agent and
  // clone path can read/drive it. JSON-compared because a fresh object is built
  // each render; the secret never enters shared state.
  useEffect(() => {
    if (!wizardCtx) return;
    const { mcpAuthHeader: _omit, ...shareable } = reactConfig;
    const shared = wizardCtx.state.react_config;
    if (JSON.stringify(shared ?? null) !== JSON.stringify(shareable)) {
      wizardCtx.setField("react_config", shareable as Record<string, unknown>, "user");
    }
  }, [reactConfig, wizardCtx]);

  // Outgoing: optimizer_kwargs — rebuild from the quartet and compare entries.
  useEffect(() => {
    if (!wizardCtx) return;
    const kw = buildOptimizerKwargs({
      autoLevel,
      maxFullEvals: advancedMode ? maxFullEvals : DEFAULT_MAX_FULL_EVALS,
      maxMetricCalls: advancedMode ? maxMetricCalls : "",
      reflectionMinibatchSize: advancedMode
        ? reflectionMinibatchSize
        : DEFAULT_REFLECTION_MINIBATCH,
      useMerge: advancedMode ? useMerge : true,
      pxnParents: advancedMode ? pxnParents : DEFAULT_PXN,
      pxnProposals: advancedMode ? pxnProposals : DEFAULT_PXN,
    });
    const shared = wizardCtx.state.optimizer_kwargs ?? {};
    const kwEntries = Object.entries(kw);
    const same =
      Object.keys(shared).length === kwEntries.length &&
      kwEntries.every(([k, v]) => shared[k] === v);
    if (!same) {
      wizardCtx.setField("optimizer_kwargs", kw, "user");
    }
  }, [
    advancedMode,
    autoLevel,
    maxFullEvals,
    maxMetricCalls,
    reflectionMinibatchSize,
    useMerge,
    pxnParents,
    pxnProposals,
    wizardCtx,
  ]);

  // Chat-driven dataset staging: when the user attaches a CSV/JSON/XLSX
  // file in the agent panel and confirms the column roles, the panel
  // dispatches ``wizard:dataset-staged`` with ``{dataset, dataset_filename,
  // wizard_state: {dataset_columns, column_roles, column_kinds}}``. The
  // panel ALSO stashes the same payload in sessionStorage under
  // ``wizard:staged-dataset`` so navigating from /explore to /submit
  // doesn't drop the event when the wizard hasn't mounted yet.
  useEffect(() => {
    const applyStaged = (detail: unknown) => {
      if (!detail || typeof detail !== "object") return;
      const d = detail as Record<string, unknown>;
      const rows = d.dataset;
      const ws = (d.wizard_state ?? {}) as Record<string, unknown>;
      if (!Array.isArray(rows) || rows.length === 0) return;
      const stagedColumns = ws.dataset_columns;
      const columns =
        Array.isArray(stagedColumns) && stagedColumns.length > 0
          ? (stagedColumns as string[])
          : Object.keys((rows[0] ?? {}) as Record<string, unknown>);
      const parsed: ParsedDataset = {
        columns,
        rows: rows as Array<Record<string, unknown>>,
        rowCount: rows.length,
      };
      // This same-page fast path already carries the rows; record the staged
      // id (when present) so the outgoing effect doesn't re-stage identical
      // rows under a new id and the incoming hydration effect skips a refetch.
      const eventStagedId = typeof d.staged_dataset_id === "string" ? d.staged_dataset_id : null;
      if (eventStagedId) parsedDatasetStagedIdRef.current = eventStagedId;
      lastStagedDatasetRef.current = parsed;
      setParsedDataset(parsed);
      const explicitFilename =
        typeof d.dataset_filename === "string" && d.dataset_filename ? d.dataset_filename : null;
      const jobBasedFilename =
        typeof ws.job_name === "string" && ws.job_name ? `${ws.job_name}.json` : null;
      setDatasetFileName(explicitFilename ?? jobBasedFilename ?? "sample.json");
      const stagedDefaultMode = readPref("wizardSplitMode");
      splitModeRef.current = stagedDefaultMode;
      setSplitModeState(stagedDefaultMode);
      setDatasetProfile(null);
      setSplitPlan(null);
      setSignatureValidation(null);
      setMetricValidation(null);
      // This dataset was staged by the agent panel; the agent owns code
      // authoring (request_code_authoring), so suppress the wizard's own
      // auto-seed to avoid a second, racing Signature/Metric. The agent's
      // authored code lands here via an applyAgentPatch.
      setSignatureManuallyEdited(true);
      setMetricManuallyEdited(true);
      if (ws.column_kinds && typeof ws.column_kinds === "object") {
        const stagedKinds: Record<string, "text" | "image"> = {};
        for (const [col, kind] of Object.entries(ws.column_kinds as Record<string, unknown>)) {
          stagedKinds[col] = kind === "image" ? "image" : "text";
        }
        setColumnKinds(stagedKinds);
      }
      if (ws.column_roles && typeof ws.column_roles === "object") {
        const stagedRoles: Record<string, "input" | "output" | "ignore"> = {};
        for (const [col, role] of Object.entries(ws.column_roles as Record<string, unknown>)) {
          if (role === "input" || role === "output" || role === "ignore") {
            stagedRoles[col] = role;
          }
        }
        if (Object.keys(stagedRoles).length > 0) setColumnRoles(stagedRoles);
      }
    };

    if (typeof window !== "undefined") {
      try {
        const raw = window.sessionStorage.getItem("wizard:staged-dataset");
        if (raw) {
          window.sessionStorage.removeItem("wizard:staged-dataset");
          applyStaged(JSON.parse(raw));
        }
      } catch {
        window.sessionStorage.removeItem("wizard:staged-dataset");
      }
    }

    const handler = (e: Event) => applyStaged((e as CustomEvent).detail);
    window.addEventListener("wizard:dataset-staged", handler);
    return () => window.removeEventListener("wizard:dataset-staged", handler);
  }, []);

  // Auto-seed columnKinds from the dataset profile. The profiler returns
  // ``inputs: [{name, kind}]`` once it has classified each input column; we
  // fill any column the user hasn't already overridden. A fresh dataset
  // upload clears columnKinds entirely, so this effect re-seeds on every
  // new file. Columns the user has manually flipped stay flipped.
  useEffect(() => {
    if (!datasetProfile?.inputs?.length) return;
    setColumnKinds((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const entry of datasetProfile.inputs) {
        if (next[entry.name] === undefined) {
          next[entry.name] = entry.kind === "image" ? "image" : "text";
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [datasetProfile]);

  // Auto-update signature template when column roles or modalities change.
  // ``columnKinds`` flips an input column to ``dspy.Image`` so the auto
  // template tracks the modality toggle without waiting for the AI agent.
  useEffect(() => {
    if (signatureManuallyEdited) return;
    const hasRoles = Object.values(columnRoles).some((r) => r === "input" || r === "output");
    if (!hasRoles) return;
    setSignatureCode(buildSignatureTemplate(columnRoles, columnKinds));
  }, [columnRoles, columnKinds, signatureManuallyEdited]);

  // Auto-update metric template when output roles change. The agent
  // overwrites this in auto mode; the manual-edit flag protects a user's
  // edits from being clobbered when they toggle between columns afterwards.
  useEffect(() => {
    if (metricManuallyEdited) return;
    const hasOutputs = Object.values(columnRoles).some((r) => r === "output");
    if (!hasOutputs) return;
    setMetricCode(buildMetricTemplate(columnRoles));
  }, [columnRoles, metricManuallyEdited]);

  useEffect(() => {
    const cloneId = searchParams.get("clone");
    // A restored draft owns the form; the clone URL it was continued past must
    // not hydrate over it.
    if (!cloneId || cloneRan.current || draftSnapshot) return;
    cloneRan.current = true;
    const pairParam = searchParams.get("pair");
    const clonePairIndex = pairParam == null ? null : Number(pairParam);
    const shareToken = searchParams.get("shareToken");
    // Forking a public Explore run: there's no share token, so hydrate from the
    // by-id scrubbed public composite instead of the authed owner endpoints.
    const publicClone = searchParams.get("public") === "1";
    setCloneLoading(true);

    // Maps a cloned optimization payload into wizard state. Shared between the
    // authed clone path and the token-gated share clone path; the latter passes
    // a synthetic payload whose ``dataset`` is rebuilt from the public split.
    const applyClone = (
      optimization_type: string,
      payload: Record<string, unknown>,
      jobData: Awaited<ReturnType<typeof getJob>> | null,
    ) => {
      const clonePair =
        Number.isInteger(clonePairIndex) && jobData?.grid_result
          ? (jobData.grid_result.pair_results.find((p) => p.pair_index === clonePairIndex) ?? null)
          : null;
      setOptimizationType(
        clonePair
          ? "run"
          : advancedMode && optimization_type === "grid_search"
            ? "grid_search"
            : "run",
      );

      // Only a Program run carries a module, signature and metric. An Anything
      // run cloned into this recipe (the picker lets the user switch) brings
      // its basics and rows; the Start step drafts the rest from them.
      const fromProgram = cloneSourceRecipe(optimization_type) === "program";
      const basics = cloneBasics(payload, jobData?.name);
      // A cloned run's name is decided; the suggestion must not replace it
      // once the cloned code and dataset land.
      if (basics.name) {
        setJobName(basics.name);
        setJobNameTouched(true);
      }
      if (basics.description) setJobDescription(basics.description);
      if (basics.isPrivate != null) setIsPrivate(basics.isPrivate);
      if (fromProgram) {
        if (payload.module_name) setModuleName(String(payload.module_name));
        // A clone is a complete prior submission — its module (absent = the
        // predict default) is already decided, so the picker never reopens.
        setModuleChosen(true);
        if (payload.optimizer_name) setOptimizerName(String(payload.optimizer_name));
        if (payload.signature_code) {
          setSignatureCode(String(payload.signature_code));
          setSignatureManuallyEdited(true);
        }
        if (payload.metric_code) {
          setMetricCode(String(payload.metric_code));
          setMetricManuallyEdited(true);
        }
      }

      const rows = cloneRows(payload);
      if (rows) {
        setParsedDataset(rows);
        setDatasetFileName(String(payload.dataset_filename || basics.name || cloneId));
        setColumnRoles(cloneColumnRoles(payload, rows.columns));
      }

      if (basics.split) {
        setSplit({ ...defaultSplit, ...basics.split });
        // Cloned splits are intentional — pin the wizard to manual so the
        // auto-profile effect doesn't clobber them when the dataset reloads.
        splitModeRef.current = "manual";
        setSplitModeState("manual");
      }

      if (basics.shuffle != null) setShuffle(basics.shuffle);
      if (basics.seed != null) setSeed(basics.seed);

      if (clonePair) {
        const findPairModel = (
          models: ModelConfig[] | undefined,
          name: string,
          reasoningEffort?: string | null,
        ) => {
          const match = models?.find(
            (model) =>
              model.name === name &&
              (!reasoningEffort || model.extra?.reasoning_effort === reasoningEffort),
          );
          if (match) return { ...emptyModelConfig(), ...match };
          return {
            ...emptyModelConfig(),
            name,
            extra: reasoningEffort ? { reasoning_effort: reasoningEffort } : undefined,
          };
        };
        setModelConfig(
          findPairModel(
            payload.generation_models as ModelConfig[] | undefined,
            clonePair.generation_model,
            clonePair.generation_reasoning_effort,
          ),
        );
        setSecondModelConfig(
          findPairModel(
            payload.reflection_models as ModelConfig[] | undefined,
            clonePair.reflection_model,
            clonePair.reflection_reasoning_effort,
          ),
        );
      } else {
        const mc = payload.model_config as ModelConfig | undefined;
        if (mc) setModelConfig({ ...emptyModelConfig(), ...mc });

        const smc = (payload.reflection_model_config ?? payload.task_model_config) as
          | ModelConfig
          | undefined;
        if (smc?.name) setSecondModelConfig({ ...emptyModelConfig(), ...smc });

        const gm = payload.generation_models as ModelConfig[] | undefined;
        if (gm?.length) setGenerationModels(gm.map((m) => ({ ...emptyModelConfig(), ...m })));

        const rm = payload.reflection_models as ModelConfig[] | undefined;
        if (rm?.length) setReflectionModels(rm.map((m) => ({ ...emptyModelConfig(), ...m })));

        if (!advancedMode && optimization_type === "grid_search") {
          const firstGeneration = gm?.find((model) => model.name?.trim());
          const firstReflection = rm?.find((model) => model.name?.trim());
          if (firstGeneration) setModelConfig({ ...emptyModelConfig(), ...firstGeneration });
          if (firstReflection) setSecondModelConfig({ ...emptyModelConfig(), ...firstReflection });
        }
      }

      const optKw = payload.optimizer_kwargs as Record<string, unknown> | undefined;
      if (optKw) {
        // A cloned explicit budget (max_full_evals / max_metric_calls) must
        // clear the auto tier — GEPA takes exactly one of the three, and the
        // "light" default would otherwise win the kwargs rebuild.
        if (optKw.auto) setAutoLevel(String(optKw.auto));
        else if (optKw.max_full_evals != null || optKw.max_metric_calls != null) setAutoLevel("");
        if (optKw.reflection_minibatch_size != null)
          setReflectionMinibatchSize(String(optKw.reflection_minibatch_size));
        if (optKw.max_full_evals != null) setMaxFullEvals(String(optKw.max_full_evals));
        if (optKw.max_metric_calls != null) setMaxMetricCalls(String(optKw.max_metric_calls));
        if (optKw.use_merge != null) setUseMerge(Boolean(optKw.use_merge));
      }
      if (typeof payload.target_score === "number") {
        setTargetScore(String(payload.target_score));
      } else {
        setTargetScore("");
      }

      // React run config — hydrate tool source from the wire model. Scoring is
      // owned by metric_code (hydrated above), so there is no reward to restore.
      // mcp_auth_header is scrubbed from cloned/shared payloads, never present.
      // Missing/null is the legacy full-roster contract; an array is an exact
      // allow-list, including an invalid empty list that the wizard must repair
      // rather than silently widen.
      const ts = payload.tool_source as Record<string, unknown> | undefined;
      if (ts) {
        const toolFilter = cloneReactToolFilter(payload);
        setReactConfig((prev) => ({
          ...prev,
          ...(ts.mcp_url != null ? { mcpUrl: String(ts.mcp_url) } : {}),
          ...(toolFilter !== undefined ? { toolFilter } : {}),
        }));
      }
      // A Program clone is a decided setup: open the summary with every
      // earlier stage unlocked instead of walking the questions it already
      // answered. An Anything clone still drafts its signature and metric
      // on the Start step, so it keeps the walk.
      if (fromProgram) {
        setPendingRestore({ stage: "review", furthest: "review" });
      }
      toast.success(msg("submit.clone.success"));
    };

    // Share / public clone: hydrate from the scrubbed composite — token-gated for
    // a share link, or by id for a public Explore run. Both return the same
    // shape; the payload is scrubbed (no api_key/base_url/username) and carries no
    // dataset rows, so reconstruct them from the full train/val/test split.
    const scrubbedComposite = shareToken
      ? getSharedOptimization(shareToken)
      : publicClone
        ? getPublicOptimization(cloneId)
        : null;
    const source = scrubbedComposite
      ? scrubbedComposite.then((shared) => {
          const splits = shared.dataset?.splits;
          const rows = splits
            ? [...splits.train, ...splits.val, ...splits.test]
                .sort((a, b) => a.index - b.index)
                .map((entry) => entry.row)
            : [];
          const payload: Record<string, unknown> = {
            ...shared.payload,
            ...(rows.length > 0 ? { dataset: rows } : {}),
            // The dataset endpoint carries the mapping too; fall back to it so
            // column roles hydrate even if the scrubbed payload omitted it.
            ...(shared.payload?.column_mapping == null && shared.dataset?.column_mapping
              ? { column_mapping: shared.dataset.column_mapping }
              : {}),
          };
          applyClone(shared.status.optimization_type, payload, shared.status);
        })
      : Promise.all([getOptimizationPayload(cloneId), getJob(cloneId).catch(() => null)]).then(
          ([{ optimization_type, payload }, jobData]) => {
            applyClone(optimization_type, payload as Record<string, unknown>, jobData);
          },
        );

    source
      .catch(() => {
        toast.error(msg("submit.clone.failed"));
      })
      .finally(() => setCloneLoading(false));
  }, [advancedMode]);

  const currentColumnMapping = () => buildColumnMapping(columnRoles);

  const buildSubmissionPayload = (): RunRequest | GridSearchRequest => {
    const pxnEligible = advancedMode && optimizerName.toLowerCase() === "gepa";
    const optKw = buildOptimizerKwargs({
      autoLevel,
      maxFullEvals: advancedMode ? maxFullEvals : DEFAULT_MAX_FULL_EVALS,
      maxMetricCalls: advancedMode ? maxMetricCalls : "",
      reflectionMinibatchSize: advancedMode
        ? reflectionMinibatchSize
        : DEFAULT_REFLECTION_MINIBATCH,
      useMerge: advancedMode ? useMerge : true,
      pxnParents: pxnEligible ? pxnParents : DEFAULT_PXN,
      pxnProposals: pxnEligible ? pxnProposals : DEFAULT_PXN,
    });
    const parsedTargetScore =
      advancedMode && optimizerName.toLowerCase() === "gepa"
        ? parseTargetScore(targetScore)
        : undefined;
    // Submit by reference when the on-screen rows are still the library dataset
    // we loaded — the server inlines the rows and records the link back to it.
    // Any other dataset source replaced the object identity, so fall back to
    // sending the rows inline. The two are mutually exclusive server-side.
    const librarySourceId =
      librarySource && librarySource.parsed === parsedDataset ? librarySource.id : null;
    const tokenSource = estimateTokenSource;
    // Persist the chargeable bracket the user just saw so it can be
    // reconciled against the actual charge. Same bracket the cost
    // surface and review recap showed (managed: full per-model; byok: fee).
    const estimate = chargeableBracket(costBracket, tokenSource);
    const base = {
      name: jobName.trim() || suggestedName || undefined,
      description: jobDescription.trim() || undefined,
      username: username.trim(),
      module_name: moduleName,
      // A workflow run carries its per-node signatures inside the graph
      // spec; every other module wraps the single top-level signature.
      ...(isWorkflow && workflowSpec
        ? { workflow: workflowSpec }
        : { signature_code: signatureCode }),
      metric_code: metricCode,
      optimizer_name: optimizerName,
      execution_runtime: executionRuntime,
      ...(librarySourceId
        ? { source_dataset_id: librarySourceId }
        : { dataset: (parsedDataset?.rows ?? []) as Array<Record<string, unknown>> }),
      dataset_filename: datasetFileName || undefined,
      column_mapping: currentColumnMapping(),
      // Preserve the on-screen column order (file order) so a clone restores
      // it — JSONB would otherwise scramble the dataset's object-key order.
      column_order: parsedDataset?.columns,
      split_fractions: split,
      shuffle,
      is_private: isPrivate,
      token_source: tokenSource,
      estimated_credits_low: estimate.lowCredits,
      estimated_credits_high: estimate.highCredits,
      ...(!budgetUncapped && maxCostCredits != null && { max_cost_credits: maxCostCredits }),
      ...(parsedTargetScore != null && { target_score: parsedTargetScore }),
      ...(seed != null && { seed }),
      ...(Object.keys(optKw).length > 0 && { optimizer_kwargs: optKw }),
    };

    // Reshape the flat UI react config into the backend ToolSource wire
    // model. mcp_auth_header is forwarded once on the wire but never persisted
    // (backend) or mirrored into shared agent state.
    const buildReactFields = () => ({ tool_source: buildLiveMcpToolSource(reactConfig) });

    const needsToolSource =
      isReact || (isWorkflow && !!workflowSpec && workflowUsesTools(workflowSpec));
    if (effectiveJobType === "run") {
      const secondApplied =
        optimizerName.toLowerCase() === "gepa" && secondModelConfig?.name?.trim()
          ? prepareModelConfig(secondModelConfig)
          : undefined;
      return {
        ...base,
        model_config: prepareModelConfig(modelConfig),
        ...(secondApplied ? { reflection_model_config: secondApplied } : {}),
        ...(needsToolSource ? buildReactFields() : {}),
      };
    }
    return {
      ...base,
      generation_models: generationModels.filter((m) => m.name.trim()).map(prepareModelConfig),
      reflection_models: reflectionModels.filter((m) => m.name.trim()).map(prepareModelConfig),
    };
  };

  const preflight = useWizardPreflight("dspy", buildSubmissionPayload(), budgetSession);
  const currentEvidence =
    preflight.evidence.execution?.identity === preflight.identity
      ? preflight.evidence.execution
      : preflight.evidence.evaluation;
  const evaluationStatus =
    currentEvidence?.identity === preflight.identity &&
    currentEvidence.response.status === "succeeded"
      ? "passed"
      : currentEvidence
        ? "stale"
        : "idle";
  const goNext = () => {
    navigationRevisionRef.current += 1;
    validationToastRef.current?.dismiss();
    preflight.cancel();
    if (step < LAST_WIZARD_STAGE) {
      setDirection(1);
      setStep((s) => {
        const next = s + 1;
        setFurthestReachedStep((prev) => Math.max(prev, next));
        return next;
      });
    }
  };
  const goPrev = () => {
    navigationRevisionRef.current += 1;
    validationToastRef.current?.dismiss();
    preflight.cancel();
    if (step > 0) {
      setDirection(-1);
      setStep((s) => s - 1);
    }
  };
  const goTo = (idx: number) => {
    navigationRevisionRef.current += 1;
    validationToastRef.current?.dismiss();
    preflight.cancel();
    setDirection(idx > step ? 1 : -1);
    setStep(idx);
    setFurthestReachedStep((prev) => Math.max(prev, idx));
  };

  const targetScoreIssue = (): string | null => {
    if (!advancedMode || optimizerName.toLowerCase() !== "gepa" || !targetScore.trim()) return null;
    if (parseTargetScore(targetScore) == null) return msg("submit.validation.target_score_invalid");
    const effectiveFractions =
      splitModeRef.current === "auto" && splitPlan ? splitPlan.fractions : split;
    if (effectiveFractions.val <= 0) return msg("submit.validation.target_score_requires_val");
    return null;
  };

  useDatasetProfiling({
    parsedDataset,
    columnRoles,
    splitModeRef,
    setDatasetProfile,
    setSplitPlan,
    setProfileLoading,
    setSplit,
    setShuffle,
    setSeed,
  });

  const setSplitMode = useCallback(
    (mode: "auto" | "manual") => {
      splitModeRef.current = mode;
      setSplitModeState(mode);
      if (mode === "auto" && splitPlan) {
        setSplit(splitPlan.fractions);
        setShuffle(splitPlan.shuffle);
        setSeed(splitPlan.seed);
      }
    },
    [splitPlan],
  );

  const evaluationIdentity = JSON.stringify([
    signatureCode,
    metricCode,
    executionRuntime,
    currentColumnMapping(),
    parsedDataset?.rows[0],
    parsedDataset?.rowCount,
    split,
    shuffle,
    seed,
    optimizerName,
    moduleName,
    workflowSpec,
  ]);
  const evaluationIdentityRef = useRef(evaluationIdentity);
  useEffect(() => {
    evaluationIdentityRef.current = evaluationIdentity;
  }, [evaluationIdentity]);
  /** The first problem holding a stage back, or null when it validates. */
  const stageIssue = (s: number, structureOnly = false): WizardIssue | null => {
    const fail = (message: string, fieldId?: string): WizardIssue => ({
      stage: stageAt(s),
      fieldId,
      message,
    });
    switch (s) {
      case WIZARD_STAGE.goal:
        if (moduleSelectionRequired)
          return fail(msg("submit.validation.module_required"), "module-selector");
        return null;
      case WIZARD_STAGE.evaluation: {
        if (!parsedDataset || parsedDataset.rowCount === 0)
          return fail(msg("submit.validation.dataset_required"), "dataset-upload");
        const m = currentColumnMapping();
        if (Object.keys(m.inputs).length === 0)
          return fail(msg("submit.validation.input_column_required"), "column-mapping");
        if (Object.keys(m.outputs).length === 0)
          return fail(msg("submit.validation.output_column_required"), "column-mapping");
        // Tool-using runs (react, or a workflow with react/mcp nodes) need a
        // live tool endpoint; the tool config lives in this stage's code section.
        const needsTools =
          isReact || (isWorkflow && !!workflowSpec && workflowUsesTools(workflowSpec));
        if (needsTools && !reactConfig.mcpUrl.trim())
          return fail(msg("submit.validation.mcp_url_required"), "react-config");
        if (needsTools && reactToolSelectionEmpty)
          return fail(msg("submit.validation.mcp_tool_required"), "react-config");
        if (isWorkflow) {
          if (!workflowSpec || validateWorkflowSpec(workflowSpec, workflowIssueText).length > 0)
            return fail(msg("submit.validation.workflow_invalid"), "signature-editor");
        } else if (!signatureCode.trim()) {
          return fail(msg("submit.validation.signature_required"), "signature-editor");
        }
        if (!metricCode.trim())
          return fail(msg("submit.validation.metric_required"), "metric-editor");
        if (Math.abs(split.train + split.val + split.test - 1) > 0.001)
          return fail(msg("submit.validation.split_must_sum_to_one"), "data-splits");
        // Server-side validation covers the signature and the metric together;
        // The paid check runs after the budget is set, before entering Review.
        if (!structureOnly && evaluationStatus !== "passed")
          return fail(msg("submit.preflight.idle"));
        if (!structureOnly && datasetValidation && datasetValidation.errors.length > 0)
          return fail(msg("submit.validation.split_too_small"), "data-splits");
        return null;
      }
      case WIZARD_STAGE.optimization: {
        if (!budgetUncapped && maxCostCredits == null)
          return fail(msg("budget.invalid"), "totalBudgetInput");
        if (!structureOnly && runtimeUnavailableReason) return fail(runtimeUnavailableReason);
        const targetProblem = targetScoreIssue();
        if (targetProblem) return fail(targetProblem, "target-score");
        if (effectiveJobType === "run") {
          if (!modelConfig.name.trim())
            return fail(msg("submit.validation.model_required"), "model-catalog");
          if (!structureOnly && modelConfig.token_source !== "byok" && !anyProviderHasEnvKey)
            return fail(msg("submit.validation.api_key_required"), "model-catalog");
          if (optimizerName.toLowerCase() === "gepa" && !secondModelConfig?.name?.trim())
            return fail(msg("submit.validation.reflection_model_required"), "model-catalog");
        }
        if (effectiveJobType === "grid_search") {
          if (generationModels.every((m) => !m.name.trim()))
            return fail(msg("submit.validation.generation_model_required"), "model-catalog");
          if (reflectionModels.every((m) => !m.name.trim()))
            return fail(msg("submit.validation.reflection_models_required"), "model-catalog");
        }
        // Vision gate: if any input column is image-typed, every chosen
        // generation model must support vision. Mirrors the backend's
        // ``submission.vision_required`` rejection so we fail fast in the UI
        // instead of waiting for a 400 from /run.
        const imageInputs = Object.entries(columnKinds)
          .filter(([col, kind]) => kind === "image" && columnRoles[col] === "input")
          .map(([col]) => col);
        if (!structureOnly && imageInputs.length > 0 && catalog?.models?.length) {
          const visionByValue = new Map(catalog.models.map((m) => [m.value, m.supports_vision]));
          const isVision = (id: string): boolean => visionByValue.get(id) ?? false;
          const candidates: string[] =
            effectiveJobType === "run"
              ? [modelConfig.name].filter((n) => n.trim())
              : generationModels.map((m) => m.name).filter((n) => n.trim());
          const offenders = candidates.filter((id) => !isVision(id));
          if (offenders.length > 0)
            return fail(
              formatMsg("submit.validation.vision_required", {
                fields: imageInputs.join(", "),
                model: offenders.join(", "),
              }),
              "model-catalog",
            );
        }
        return null;
      }
      case WIZARD_STAGE.review:
        if (!username.trim()) return fail(msg("submit.validation.username_required"));
        if (!jobName.trim() && !suggestedName)
          return fail(msg("submit.validation.name_required"), "job-name");
        return null;
      default:
        return null;
    }
  };
  /** Validates a stage; `report` records its first problem for inline display. */
  const validateStep = (s: number, report = false, structureOnly = false): boolean => {
    const found = stageIssue(s, structureOnly);
    if (found && report) setIssue(found);
    return found == null;
  };

  const maxReachableStep = furthestReachedStep;

  // A restored draft reopens where the user left off only while every earlier
  // stage still passes. The first stage that no longer validates opens instead
  // and also caps the unlocked range, because the stepper lets the user jump
  // forward to any unlocked stage without re-validating.
  useEffect(() => {
    if (!pendingRestore) return;
    setPendingRestore(null);
    const target = WIZARD_STAGE[pendingRestore.stage];
    const furthest = Math.max(target, WIZARD_STAGE[pendingRestore.furthest]);
    let open = target;
    let reachable = furthest;
    for (let i = 0; i < furthest; i++) {
      if (!validateStep(i, false, true)) {
        open = Math.min(open, i);
        reachable = i;
        break;
      }
    }
    setStep(open);
    setFurthestReachedStep((prev) => Math.max(prev, reachable));
  }, [pendingRestore, validateStep]);

  const validateBlock = async (
    kind: "signature" | "metric",
    overrideCode?: string,
  ): Promise<ValidateCodeResponse | EditorValidationResult> => {
    const code = overrideCode ?? (kind === "signature" ? signatureCode : metricCode);
    if (!code.trim()) {
      return {
        valid: false,
        errors: [formatMsg("submit.validation.missing_code", { kind })],
        warnings: [],
      };
    }
    if (!parsedDataset || parsedDataset.rowCount === 0) {
      return { valid: false, errors: [msg("submit.validation.dataset_before_code")], warnings: [] };
    }
    const mapping = currentColumnMapping();
    const cacheKey = JSON.stringify([kind, code, mapping, optimizerName, moduleName]);
    const cached = validationCacheRef.current.get(cacheKey);
    if (cached) return cached;
    const pending = validateCode({
      signature_code: kind === "signature" ? code : undefined,
      metric_code: kind === "metric" ? code : undefined,
      column_mapping: mapping,
      optimizer_name: optimizerName,
      module_name: moduleName,
    });
    validationCacheRef.current.set(cacheKey, pending);
    pending.then(
      (result) => {
        if (!result.valid || result.errors.length > 0) validationCacheRef.current.delete(cacheKey);
      },
      () => validationCacheRef.current.delete(cacheKey),
    );
    return pending;
  };

  const runSignatureValidation = async (
    overrideCode?: string,
  ): Promise<EditorValidationResult | null> => {
    try {
      const identity = evaluationIdentityRef.current;
      const result = await validateBlock("signature", overrideCode);
      if (mountedRef.current && identity === evaluationIdentityRef.current)
        setSignatureValidation(result as ValidateCodeResponse);
      return result;
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : msg("submit.validation.signature_failed");
      return { valid: false, errors: [errorMessage], warnings: [] };
    }
  };

  const runMetricValidation = async (
    overrideCode?: string,
  ): Promise<EditorValidationResult | null> => {
    try {
      const identity = evaluationIdentityRef.current;
      const result = await validateBlock("metric", overrideCode);
      if (mountedRef.current && identity === evaluationIdentityRef.current)
        setMetricValidation(result as ValidateCodeResponse);
      return result;
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : msg("submit.validation.metric_failed");
      return { valid: false, errors: [errorMessage], warnings: [] };
    }
  };

  const handleValidateCode = async (
    report: (text: string) => void = (text) => toast.error(text),
  ): Promise<boolean> => {
    if (!parsedDataset || parsedDataset.rowCount === 0) {
      report(msg("submit.validation.dataset_before_code"));
      return false;
    }
    try {
      const [sigRes, metRes] = await Promise.all([
        signatureCode.trim() ? runSignatureValidation() : Promise.resolve(null),
        metricCode.trim() ? runMetricValidation() : Promise.resolve(null),
      ]);
      const sigOk = !sigRes || sigRes.errors.length === 0;
      const metOk = !metRes || metRes.errors.length === 0;
      if (sigOk && metOk) return true;
      report(msg("submit.validation.code_has_errors"));
      return false;
    } catch (err) {
      report(err instanceof Error ? err.message : msg("submit.code_validation_failed"));
      return false;
    }
  };

  const handleValidateDataset = async (
    report: (text: string) => void = (text) => toast.error(text),
  ): Promise<boolean> => {
    if (!parsedDataset || parsedDataset.rowCount === 0) {
      report(msg("submit.validation.dataset_required"));
      return false;
    }
    const effectiveFractions =
      splitModeRef.current === "auto" && splitPlan ? splitPlan.fractions : split;
    const sum = effectiveFractions.train + effectiveFractions.val + effectiveFractions.test;
    if (Math.abs(sum - 1) > 0.001) {
      report(msg("submit.validation.split_must_sum_to_one"));
      return false;
    }
    try {
      const identity = evaluationIdentityRef.current;
      const result = await validateDataset({
        row_count: parsedDataset.rowCount,
        fractions: effectiveFractions,
      });
      if (mountedRef.current && identity === evaluationIdentityRef.current)
        setDatasetValidation(result);
      if (result.errors.length === 0) return true;
      report(msg("submit.validation.split_too_small"));
      return false;
    } catch (err) {
      report(err instanceof Error ? err.message : msg("submit.validation.split_too_small"));
      return false;
    }
  };

  const advance = async (target: number) => {
    if (advancingRef.current) return;
    advancingRef.current = true;
    setAdvancing(true);
    setIssue(null);
    try {
      for (let i = 0; i < target; i++) {
        if (!validateStep(i, true, true)) {
          goTo(i);
          return;
        }
      }
      if (target > WIZARD_STAGE.optimization && !(await ensureSetupChecked("execution"))) return;
      if (mountedRef.current) goTo(target);
    } finally {
      advancingRef.current = false;
      if (mountedRef.current) setAdvancing(false);
    }
  };

  const handleNext = async () => {
    await advance(step + 1);
  };
  const handleTabClick = async (idx: number) => {
    if (idx <= step) {
      goTo(idx);
      return;
    }
    await advance(idx);
  };

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const parsed = await parseDatasetFile(file);
      setParsedDataset(parsed);
      setDatasetFileName(file.name);
      const roles: Record<string, "input" | "output" | "ignore"> = {};
      // Start every column as "ignore" so the mapping opens empty and the user
      // deliberately marks the input(s) and output(s). Defaulting to "input"
      // means a wide dataset opens with every column wrongly selected and has to
      // be un-marked one by one.
      parsed.columns.forEach((col) => {
        roles[col] = "ignore";
      });
      setColumnRoles(roles);
      // Drop any prior modality overrides — the profiler effect will re-seed
      // from the new dataset's detected kinds.
      setColumnKinds({});
      // A fresh dataset deserves a fresh recommendation — reset split mode to
      // the user's saved preference so the auto-profile effect applies the new
      // plan when they prefer auto, and stays out of the way when they prefer
      // manual.
      const uploadDefaultMode = readPref("wizardSplitMode");
      splitModeRef.current = uploadDefaultMode;
      setSplitModeState(uploadDefaultMode);
      setDatasetProfile(null);
      setSplitPlan(null);
      // A new dataset invalidates any cloned or user-authored code — clear
      // the manual-edit flags so the template effects and the code agent
      // can repopulate for the new schema.
      setSignatureManuallyEdited(false);
      setMetricManuallyEdited(false);
      setSignatureValidation(null);
      setMetricValidation(null);
      toast.success(
        formatMsg("auto.features.submit.hooks.use.submit.wizard.template.1", {
          p1: parsed.rowCount,
          p2: file.name,
        }),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : msg("submit.dataset.file_error"));
    }
  }, []);

  const handlePickFromLibrary = useCallback(async (dataset: DatasetSummary) => {
    try {
      const res = await getDatasetRows(dataset.id);
      if (res.rows.length === 0) {
        toast.error(msg("submit.dataset.library_empty"));
        return;
      }
      const columns = res.columns.length > 0 ? res.columns : Object.keys(res.rows[0] ?? {});
      const parsed: ParsedDataset = { columns, rows: res.rows, rowCount: res.row_count };
      // Bind the reference to this exact object so handleSubmit can tell a live
      // library pick from a later upload/clone by identity (see librarySource).
      setLibrarySource({ id: dataset.id, parsed });
      setParsedDataset(parsed);
      setDatasetFileName(dataset.name);
      // Restore the saved roles; any column the schema didn't cover defaults to
      // "ignore" so the user marks input/output deliberately (see handleFileUpload).
      const savedRoles = res.column_schema.column_roles ?? {};
      const roles: Record<string, "input" | "output" | "ignore"> = {};
      columns.forEach((col) => {
        roles[col] = savedRoles[col] ?? "ignore";
      });
      setColumnRoles(roles);
      // Seed saved modality kinds; the profiler effect only fills gaps, so these
      // survive its auto-detection pass.
      setColumnKinds(res.column_schema.column_kinds ?? {});
      const pickedDefaultMode = readPref("wizardSplitMode");
      splitModeRef.current = pickedDefaultMode;
      setSplitModeState(pickedDefaultMode);
      setDatasetProfile(null);
      setSplitPlan(null);
      setSignatureManuallyEdited(false);
      setMetricManuallyEdited(false);
      setSignatureValidation(null);
      setMetricValidation(null);
      toast.success(
        formatMsg("submit.dataset.library_loaded", {
          name: dataset.name,
          count: parsed.rowCount,
        }),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : msg("submit.dataset.file_error"));
    }
  }, []);

  const updateSplit = (field: keyof SplitFractions, value: string) => {
    if (splitModeRef.current === "auto") return;
    const num = parseFloat(value);
    if (isNaN(num) || num < 0 || num > 1) return;
    setSplit((prev) => ({ ...prev, [field]: num }));
  };
  const splitSum = +(split.train + split.val + split.test).toFixed(4);

  const ensureSetupChecked = async (
    scope: PreflightScope,
    preserveWorkflowResult = false,
  ): Promise<WizardPreflightResponse | null> => {
    const completed = preflight.reusable(scope);
    if (completed) return completed;
    const navigation = navigationRevisionRef.current;
    const identity = preflight.identity;
    const t = beginValidationToast(
      toast,
      `wizard-validate-${++validationAttemptRef.current}`,
      msg("submit.validation.toast.running"),
    );
    validationToastRef.current = t;
    try {
      const response = await preflight.run(scope);
      if (
        !mountedRef.current ||
        navigation !== navigationRevisionRef.current ||
        !preflight.isCurrent(identity)
      ) {
        t.obsolete(msg("submit.validation.toast.obsolete"));
        return null;
      }
      if (preflightMayAdvance(response, scope)) {
        if (response.status === "succeeded") {
          const locale = getActiveIntlLocale();
          t.succeed(
            `${msg("submit.preflight.succeeded")} · ${msg("submit.budget.setup_spent")}: ${formatBudgetAmount(response.budget.setup_spent_credits, locale)} · ${msg("submit.budget.available")}: ${formatBudgetAmount(response.budget.available_credits, locale)}`,
          );
        } else {
          t.pending(msg(preflightPendingMessageKey(response)));
        }
        return response;
      }
      if (response.status === "pending") {
        t.fail(msg(preflightPendingMessageKey(response)));
        return preserveWorkflowResult && response.workflow_result ? response : null;
      }
      const failure = response.checks.find((check) => check.status === "failed");
      t.fail(failure?.message ?? msg("submit.preflight.failed"));
      if (preserveWorkflowResult && response.workflow_result) return response;
      const destination = preflightDestination("dspy", failure?.field ?? failure?.key, scope);
      goTo(WIZARD_STAGE[destination.stage]);
      setIssue({
        ...destination,
        message: failure?.message ?? msg("submit.preflight.failed"),
        identity,
      });
      return null;
    } catch (error) {
      if (mountedRef.current && navigation === navigationRevisionRef.current) {
        const message = error instanceof Error ? error.message : msg("submit.preflight.failed");
        t.fail(message.startsWith("budget.") ? msg(message as MessageKey) : message);
        if (message.startsWith("budget.")) {
          goTo(WIZARD_STAGE.optimization);
          setIssue({
            stage: "optimization",
            fieldId: "totalBudgetInput",
            message: msg(message as MessageKey),
            identity,
          });
        }
      }
      return null;
    } finally {
      if (!t.settled) t.dismiss();
    }
  };

  const handleSubmit = async () => {
    if (advancingRef.current || submitting) return;
    setIssue(null);
    for (let i = 0; i <= LAST_WIZARD_STAGE; i++) {
      if (!validateStep(i, true, true)) {
        goTo(i);
        return;
      }
    }
    advancingRef.current = true;
    setAdvancing(true);
    let checked: WizardPreflightResponse | null;
    try {
      checked = await ensureSetupChecked("execution");
      if (!checked) return;
    } finally {
      advancingRef.current = false;
      if (mountedRef.current) setAdvancing(false);
    }
    if (!mountedRef.current) return;
    setSubmitting(true);
    setSubmitPhase("sending");
    try {
      const payload = {
        ...buildSubmissionPayload(),
        execution_budget_id: checked.budget.id,
        execution_budget_revision: checked.budget.revision,
        preflight_id: checked.id,
        preflight_fingerprint: checked.fingerprint,
      };
      const key = await budgetSession.submissionKey(checked.fingerprint);
      let result;
      if ("model_config" in payload) {
        result = await submitRun(payload, key);
        track(TelemetryEvent.RunSubmitted, {
          react: isReact,
          has_reflection: Boolean(payload.reflection_model_config),
        });
      } else {
        result = await submitGridSearch(payload, key);
        track(TelemetryEvent.GridSearchSubmitted, {
          generation_models: payload.generation_models.length,
          reflection_models: payload.reflection_models.length,
        });
      }

      // Mark the submit so the unmount cleanup clears the shared wizard state
      // once navigation tears this form down.
      submittedRef.current = true;
      draftsRef.current.consumed();
      const jobUrl = `/optimizations/${result.optimization_id}`;
      setSubmitPhase("splash");
      // Collapse sidebar before navigating so the job page opens with full width
      window.dispatchEvent(new Event("sidebar:collapse"));
      setTimeout(() => {
        setSubmitPhase("done");
        router.push(jobUrl);
      }, 1500);
    } catch (err) {
      // The storage-budget 409 and the credit-gate 402 each open their own shared
      // modal centrally; suppress the redundant toast so the modal is the single
      // surface for both.
      if (!isStorageQuotaError(err) && !isInsufficientCreditsError(err)) {
        toast.error(err instanceof Error ? err.message : msg("submit.submit_failed"));
      }
      setSubmitPhase("idle");
      setSubmitting(false);
    }
  };

  // Dry-run binding for the workflow canvas: sample values come from the
  // first dataset row (keyed by the sanitized input-anchor field names the
  // starter graph derived from the same columns), and the billed test call
  // reuses the run's model + tool source exactly as submit would send them.
  const workflowSampleInputs = useMemo(() => {
    const samples: Record<string, string> = {};
    const firstRow = parsedDataset?.rows?.[0];
    if (!firstRow) return samples;
    for (const [column, role] of Object.entries(columnRoles)) {
      if (role !== "input") continue;
      const field = column.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^(\d)/, "_$1");
      const value = (firstRow as Record<string, unknown>)[column];
      if (value != null) samples[field] = String(value);
    }
    return samples;
  }, [parsedDataset, columnRoles]);

  const workflowNeedsTools = isWorkflow && workflowSpec && workflowUsesTools(workflowSpec);
  const workflowDryRunDisabledReason = workflowNeedsTools
    ? !reactConfig.mcpUrl.trim()
      ? msg("submit.validation.mcp_url_required")
      : reactToolSelectionEmpty
        ? msg("submit.validation.mcp_tool_required")
        : null
    : null;
  // A dry run needs a model, but the model step comes after the code step —
  // instead of a "pick a model first" dead end, the canvas opens the shared
  // model-config modal in place and the pick carries into the model step.
  const workflowDryRunNeedsModel = !modelConfig.name.trim();
  const openDryRunModelPicker = useCallback(() => {
    setEditingModel({
      config: modelConfig,
      onSave: setModelConfig,
      label: msg("model.generation.label"),
    });
  }, [modelConfig]);

  const runWorkflowDryRun = async (
    _inputs: Record<string, unknown>,
    handlers: WorkflowDryRunStreamHandlers,
  ) => {
    if (!workflowSpec) throw new Error(msg("submit.validation.workflow_invalid"));
    if (handlers.signal?.aborted) return;
    const cancel = () => preflight.cancel();
    handlers.signal?.addEventListener("abort", cancel, { once: true });
    try {
      const response = await ensureSetupChecked("execution", true);
      if (handlers.signal?.aborted) return;
      if (response?.workflow_result) handlers.onFinal(response.workflow_result);
      else
        handlers.onError(
          msg(
            response?.status === "pending" ? "submit.preflight.pending" : "submit.preflight.failed",
          ),
        );
    } finally {
      handlers.signal?.removeEventListener("abort", cancel);
    }
  };

  // The Signature & Metric interview: a few grounded questions before the
  // seed pass, distilled into an authoring brief the seed authors honor.
  // ``interviewPending`` holds the seed anywhere in the wizard while an
  // interview could still happen — otherwise the pre-warm seed (which fires
  // from earlier steps) would generate code before the user ever saw a
  // question. ``interviewEligible`` additionally requires a role-mapped
  // dataset and the Evaluation stage (``WIZARD_STAGE.evaluation``), where the
  // code section lives, so the opening question — which costs an LLM call —
  // never fires before the dataset exists. Pre-existing code work (clone
  // pre-fill, manual edits, a touched canvas) rules the interview out.
  const interviewPossible =
    codeAssistMode === "auto" &&
    !signatureManuallyEdited &&
    !metricManuallyEdited &&
    !(isWorkflow && workflowTouched);
  const interviewEligible =
    interviewPossible &&
    !moduleSelectionRequired &&
    step >= WIZARD_STAGE.evaluation &&
    !!parsedDataset &&
    parsedDataset.rowCount > 0 &&
    Object.values(columnRoles).some((r) => r === "input") &&
    Object.values(columnRoles).some((r) => r === "output");
  const interview = useCodeInterview({
    enabled: interviewEligible,
    parsedDataset,
    columnRoles,
    columnKinds,
    jobModel: modelConfig.name,
  });

  // Hoisted to wizard scope. The seed pass now waits for the interview to
  // resolve (confirmed brief or skip) so the user's answers shape the very
  // first Signature + metric instead of a post-hoc chat correction.
  const agent = useCodeAgent({
    codeAssistMode,
    setCodeAssistMode,
    columnRoles,
    columnKinds,
    parsedDataset,
    moduleName,
    signatureCode,
    metricCode,
    setSignatureCode,
    setMetricCode,
    signatureManuallyEdited,
    metricManuallyEdited,
    setSignatureManuallyEdited,
    setMetricManuallyEdited,
    setSignatureValidation,
    setMetricValidation,
    signatureValidation,
    metricValidation,
    runSignatureValidation,
    runMetricValidation,
    isWorkflow,
    workflowSpec,
    workflowTouched,
    applyAgentWorkflow,
    // Hold the seed pass while the module picker is still open — seeding for
    // the default module would be wasted (and visibly wrong) if the user then
    // picks another one — and while an interview could still happen. When
    // the interview is ruled out (manual mode, pre-existing code work) its
    // resolution never gates anything.
    seedEnabled: !moduleSelectionRequired && (!interviewPossible || interview.resolved),
    interviewBrief: interview.confirmedBrief,
    // The conversation rides through the locale-switch reload alongside the
    // wizard draft (see use-wizard-drafts.tsx).
    reloadPersistKey: "submit-code-agent",
    model: interview.model,
    reasoningEffort: interview.reasoningEffort,
  });
  useEffect(() => {
    agentResetRef.current = agent.reset;
  }, [agent.reset]);
  useEffect(() => {
    interviewResetRef.current = interview.reset;
  }, [interview.reset]);

  return {
    step,
    setStep,
    direction,
    setDirection,
    summaryTab,
    setSummaryTab,
    summaryCodeTab,
    setSummaryCodeTab,
    goNext,
    goPrev,
    goTo,
    maxReachableStep,
    validateStep,
    stageIssue,
    issue,
    handleNext,
    evaluationStatus,
    preflight,
    handleTabClick,
    jobType: effectiveJobType,
    setOptimizationType,
    isPrivate,
    setIsPrivate,
    username,
    jobName,
    setJobName: editJobName,
    suggestedName,
    jobDescription,
    setJobDescription,
    moduleName,
    setModuleName,
    moduleChosen,
    chooseModule,
    reopenModulePicker,
    moduleSelectionRequired,
    isReact,
    isWorkflow,
    workflowSpec,
    setWorkflowSpec: updateWorkflowSpec,
    replaceWorkflowSpec,
    workflowRevision,
    agentPulseNodeId,
    workflowSampleInputs,
    workflowDryRunDisabledReason,
    workflowDryRunNeedsModel,
    openDryRunModelPicker,
    runWorkflowDryRun,
    reactConfig,
    updateReactConfig,
    optimizerName,
    setOptimizerName,
    executionRuntime,
    runtimeCatalog,
    runtimeUnavailableReason,
    optimizationTypeOpen,
    setOptimizationTypeOpen,
    optimizerSettingsOpen,
    setOptimizerSettingsOpen,
    signatureCode,
    setSignatureCode,
    setSignatureManuallyEdited,
    metricCode,
    setMetricCode,
    setMetricManuallyEdited,
    codeAssistMode,
    setCodeAssistMode,
    signatureValidation,
    setSignatureValidation,
    metricValidation,
    setMetricValidation,
    runSignatureValidation,
    runMetricValidation,
    parsedDataset,
    setParsedDataset,
    datasetFileName,
    setDatasetFileName,
    fileInputRef,
    handleFileUpload,
    handlePickFromLibrary,
    columnRoles,
    setColumnRoles,
    columnKinds,
    setColumnKinds,
    anyProviderHasEnvKey,
    modelConfig,
    setModelConfig,
    secondModelConfig,
    setSecondModelConfig,
    editingModel,
    setEditingModel,
    recentConfigs,
    saveToRecent,
    clearRecentConfigs,
    removeRecentConfig,
    catalog,
    generationModels,
    setGenerationModels,
    reflectionModels,
    setReflectionModels,
    split,
    updateSplit,
    splitSum,
    datasetProfile,
    splitPlan,
    profileLoading,
    splitMode,
    setSplitMode,
    seed,
    shuffle,
    setShuffle,
    autoLevel,
    setAutoLevel,
    reflectionMinibatchSize,
    setReflectionMinibatchSize,
    maxFullEvals,
    setMaxFullEvals,
    maxMetricCalls,
    setMaxMetricCalls,
    useMerge,
    setUseMerge,
    targetScore,
    setTargetScore,
    pxnParents,
    setPxnParents,
    pxnProposals,
    setPxnProposals,
    maxCostCredits,
    setMaxCostCredits,
    budgetUncapped,
    setBudgetUncapped,
    budgetSession,
    setupSpent,
    availableCredits,
    costBracket,
    suggestedCeiling,
    submitting,
    submitPhase,
    advancing,
    handleSubmit,
    cloneLoading,
    agent,
    interview,
    interviewEligible,
  };
}

export type SubmitWizardContext = ReturnType<typeof useSubmitWizard>;
