"use client";

import { resolveScorerDependencies } from "@/shared/lib/api";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { toast } from "react-toastify";

import type {
  BlackboxCandidate,
  BlackboxEngineCatalogResponse,
  BlackboxEngineId,
  BlackboxHarness,
  BlackboxRunRequest,
  BlackboxScorer,
  ScorerDependencyLock,
  BlackboxTarget,
  ModelConfig,
  ScorerDryRunResponse,
  SplitFractions,
  SplitPlan,
  ValidateCodeResponse,
} from "@/shared/types/api";
import {
  getBlackboxEngines,
  getDatasetRows,
  getJob,
  getOptimizationPayload,
  isInsufficientCreditsError,
  isStorageQuotaError,
  submitBlackboxRun,
  type BlackboxAuthoringContext,
  type DatasetSummary,
} from "@/shared/lib/api";
import { useWizardStateOptional } from "@/features/agent-panel";
import { readPref, useUserPrefs } from "@/features/settings";
import { useCodeAgent } from "@/shared/hooks/use-code-agent";
import { useCodeInterview } from "@/shared/hooks/use-code-interview";
import { BLACKBOX_HARNESSES } from "@/shared/lib/blackbox-harness";
import { parseDatasetFile, type ParsedDataset } from "@/shared/lib/parse-dataset";
import { formatMsg, msg } from "@/shared/lib/messages";
import { getActiveIntlLocale } from "@/shared/lib/runtime-locale";
import { track, TelemetryEvent } from "@/shared/lib/telemetry";
import type { MessageKey } from "@/shared/lib/generated/ui-catalog";
import type { ValidationResult } from "@/shared/ui/code-editor";

import {
  DEFAULT_TARGET_CONCURRENCY,
  DEFAULT_TARGET_TIMEOUT,
  defaultSplit,
  emptyModelConfig,
  type ColumnRole,
} from "../constants";
import { LAST_WIZARD_STAGE, WIZARD_STAGE, stageAt, type WizardStageId } from "../lib/wizard-steps";
import { suggestedRunName } from "../lib/budget";
import { detectLanguage, looksLikeCode, type SeedLanguage } from "../lib/seed-format";
import { cloneBasics, cloneRows, cloneSourceRecipe } from "../lib/clone-payload";
import type { WizardIssue } from "../lib/wizard-issue";
import { preflightDestination } from "../lib/preflight-destination";
import { preflightMayAdvance, preflightPendingMessageKey } from "../lib/preflight-outcome";
import {
  engineSelectionIssue,
  supportsIterationLimit,
  usesNativeProposer,
} from "../lib/engine-contract";
import {
  optimizationModelFamily,
  proposerModelConfig,
  resolveScoringModel,
  type ScoringModelMode,
} from "../lib/model-roles";
import {
  preflightIdentity,
  type ValidationEvidence,
  type EvidenceStatus,
} from "../lib/validation-evidence";
import type { PreflightScope, WizardPreflightResponse } from "@/shared/types/wizard-preflight";
import { useWizardPreflight } from "./use-wizard-preflight";
import { formatBudgetAmount } from "@/shared/lib/format-budget-amount";
import { seedPartsIssue } from "../lib/seed-parts";
import { beginValidationToast, type ValidationToast } from "../lib/validation-toast";
import {
  aggregateTokenSource,
  chargeableBracket,
  defaultCeilingForBracket,
  projectCostBracket,
  runtimeCostProjection,
  type CostBracket,
  type ProjectedModelRole,
} from "../lib/cost-bracket";
import {
  isMeaningfulAnythingDraft,
  stripModelSecrets,
  type AnythingDraftData,
} from "../lib/draft-record";
import { useWizardDrafts } from "./use-wizard-drafts";
import { useExecutionBudget } from "./use-execution-budget";
import { prepareModelConfig } from "./use-submit-wizard";
import {
  useDatasetProfiling,
  useModelCatalog,
  useRecentModelConfigs,
} from "./use-submit-wizard-data";

export type SeedMode = "text" | "parts" | "none";
// The wizard offers two kinds of starting point. Runs saved before the
// prompt kind folded into text still carry "prompt"; they land on text.
export type BlackboxRecipe = "code" | "anything";

interface SeedGuess {
  code: boolean;
  language: SeedLanguage | null;
}
const NO_GUESS: SeedGuess = { code: false, language: null };

/** Maps a stored or linked recipe onto the kinds the wizard offers. */
export function wizardRecipe(value: string | null | undefined): BlackboxRecipe {
  return value === "code" ? "code" : "anything";
}

// Black-box cases carry no column roles; the agent reads them as raw samples.
const NO_ROLES: Record<string, string> = {};
const NO_KINDS: Record<string, "text" | "image"> = {};
export interface SeedPart {
  key: string;
  value: string;
}
export type DryRunState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; result: ScorerDryRunResponse };

// The backend looks for a `score` (or `metric`) entrypoint and accepts either a
// bare number or `{"score": ..., ...side_info}` (see blackbox/scorer.py).
export const SCORER_TEMPLATE = `from skynet import llm, Image  # llm(prompt, input=None, images=None) asks the scorer model


def score(candidate, case=None):
    """Return a number — higher is better. \`case\` is one row of your cases (or None)."""
    text = candidate if isinstance(candidate, str) else "\\n".join(candidate.values())
    return float(len(text.split()))
`;

const RUN_CODE_SCORER_TEMPLATE = `import os
import subprocess
import sys
import tempfile


def score(candidate, case=None):
    """Run the candidate as a python program; the last number it prints is the score."""
    TIMEOUT_SECONDS = 30
    source = candidate if isinstance(candidate, str) else "\\n".join(candidate.values())
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as handle:
        handle.write(source)
    try:
        run = subprocess.run([sys.executable, handle.name], capture_output=True, text=True, timeout=TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        return 0.0, {"error": f"timed out after {TIMEOUT_SECONDS}s"}
    finally:
        os.unlink(handle.name)
    if run.returncode != 0:
        return 0.0, {"error": run.stderr.strip()[-2000:]}
    numbers = [token for token in run.stdout.split() if _is_number(token)]
    if not numbers:
        return 0.0, {"error": "the program printed no number", "stdout": run.stdout[-2000:]}
    return float(numbers[-1]), {"stdout": run.stdout[-2000:]}


def _is_number(token):
    try:
        float(token)
    except ValueError:
        return False
    return True
`;

// A program's natural yardstick is running it, so the code recipe opens on
// the run-program scorer instead of the generic word-count template.
function scorerTemplateFor(recipe: BlackboxRecipe): string {
  return recipe === "code" ? RUN_CODE_SCORER_TEMPLATE : SCORER_TEMPLATE;
}

// Not a wizard field: 300s covers every scorer shape the agent writes, and the
// backend caps the value at 600.
const SCORER_TIMEOUT_SECONDS = 300;
const DEFAULT_MAX_SCORER_RUNS = 100;
const DEFAULT_PATIENCE = 40;

function parseOptionalNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Whether a python scorer reaches for a model at all: only then does its
 * model matter. Comments are dropped first, since the template documents
 * `llm()` in one without ever calling it.
 */
function scorerCallsModel(code: string): boolean {
  return /\bllm\s*\(/.test(code.replace(/#.*$/gm, ""));
}

export function useBlackboxWizard(initialRecipe: BlackboxRecipe) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session } = useSession();
  const username = session?.user?.name ?? "";
  const catalog = useModelCatalog();
  const { recentConfigs, saveToRecent, removeRecentConfig } = useRecentModelConfigs();

  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState(0);
  const [furthestReachedStep, setFurthestReachedStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const advancingRef = useRef(false);
  const [submitPhase, setSubmitPhase] = useState<"idle" | "sending" | "splash" | "done">("idle");

  const [jobName, setJobName] = useState("");
  // The name follows the objective's suggestion until the user types one.
  const [jobNameTouched, setJobNameTouched] = useState(false);
  const [jobDescription, setJobDescription] = useState("");
  const [isPrivate, setIsPrivate] = useState(true);

  // The kind of starting point — a prompt, code or any other text. It follows
  // what the seed reads as; the picker's link, a draft or a clone only seeds it.
  const [recipe, setRecipeState] = useState<BlackboxRecipe>(initialRecipe);

  const [codeAssistMode, setCodeAssistMode] = useState<"auto" | "manual">(() =>
    readPref("wizardCodeAssist"),
  );
  const [seedMode, setSeedMode] = useState<SeedMode>("text");
  const [seedText, setSeedText] = useState("");
  // Hand-authored artifacts are never overwritten by the agent's unprompted
  // passes; resolving the interview lifts the guard once (see below).
  const [seedManuallyEdited, setSeedManuallyEdited] = useState(false);
  const [scorerManuallyEdited, setScorerManuallyEdited] = useState(false);
  const [seedValidation, setSeedValidation] = useState<ValidateCodeResponse | null>(null);
  const [scorerValidation, setScorerValidation] = useState<ValidateCodeResponse | null>(null);
  const [seedParts, setSeedParts] = useState<SeedPart[]>([{ key: "", value: "" }]);
  const [objective, setObjective] = useState("");
  const [background, setBackground] = useState("");
  const [targetKind, setTargetKind] = useState<"text" | "agent">("text");
  const [harness, setHarness] = useState<BlackboxHarness>("pi");
  // The model the agent harness runs on: what the run optimizes for, and no
  // part of the scorer. It carries only a name — the sandbox reaches it
  // through the platform gateway, so the rest of the config would be dead
  // weight.
  const [targetModel, setTargetModel] = useState<ModelConfig>({ name: "" });
  const [targetTimeout, setTargetTimeout] = useState(DEFAULT_TARGET_TIMEOUT);
  const [targetConcurrency, setTargetConcurrency] = useState(DEFAULT_TARGET_CONCURRENCY);

  const [parsedCases, setParsedCases] = useState<ParsedDataset | null>(null);
  const [casesName, setCasesName] = useState("");
  const [split, setSplit] = useState<SplitFractions>(defaultSplit);
  const [shuffle, setShuffle] = useState(true);
  const [seed, setSeed] = useState<number | undefined>(undefined);
  const [libraryOpen, setLibraryOpen] = useState(false);

  // Same split UX as the standard wizard: the server recommends a plan from
  // the cases, auto mode follows it and manual mode keeps the user's numbers.
  // The ref lets the profiling effect read the mode without re-running.
  const [splitPlan, setSplitPlan] = useState<SplitPlan | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [splitMode, setSplitModeState] = useState<"auto" | "manual">(() =>
    readPref("wizardSplitMode"),
  );
  const splitModeRef = useRef<"auto" | "manual">(readPref("wizardSplitMode"));
  const { prefs } = useUserPrefs();

  // Skip the first run: UserPrefsProvider boots with DEFAULT_PREFS and only
  // hydrates from localStorage in an effect, so the first `prefs.*` value
  // would clobber what readPref() read synchronously above.
  const splitModeFirstRunRef = useRef(true);
  useEffect(() => {
    if (splitModeFirstRunRef.current) {
      splitModeFirstRunRef.current = false;
      return;
    }
    splitModeRef.current = prefs.wizardSplitMode;
    setSplitModeState(prefs.wizardSplitMode);
  }, [prefs.wizardSplitMode]);

  // Every case column feeds the black box, so the whole row is the profiler's
  // duplicate key — there are no output columns to map.
  const caseColumnRoles = useMemo<Record<string, ColumnRole>>(
    () =>
      Object.fromEntries((parsedCases?.columns ?? []).map((column) => [column, "input"] as const)),
    [parsedCases],
  );
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
  const updateSplit = (field: keyof SplitFractions, value: string) => {
    if (splitModeRef.current === "auto") return;
    const num = parseFloat(value);
    if (isNaN(num) || num < 0 || num > 1) return;
    setSplit((prev) => ({ ...prev, [field]: num }));
  };
  const splitSum = +(split.train + split.val + split.test).toFixed(4);

  const [scorerKind, setScorerKind] = useState<"python" | "remote">("python");
  const [metricCode, setMetricCode] = useState(scorerTemplateFor(initialRecipe));
  // The kind only seeds the scorer: a scorer still on the outgoing kind's
  // template follows the switch, while anything the user or the agent wrote
  // stays put.
  const setRecipe = useCallback(
    (next: BlackboxRecipe) => {
      if (metricCode === scorerTemplateFor(recipe)) setMetricCode(scorerTemplateFor(next));
      setRecipeState(next);
    },
    [metricCode, recipe],
  );
  const [scorerUrl, setScorerUrl] = useState("");
  const [scorerSecret, setScorerSecret] = useState("");
  const [scorerInstall, setScorerInstall] = useState("");
  const [scorerPackages, setScorerPackages] = useState("");
  const [scorerDependencyLock, setScorerDependencyLock] = useState<ScorerDependencyLock | null>(
    null,
  );
  // A metric is any function; only one that calls `llm()` needs a model, and
  // the code says whether it does.
  const [scorerModel, setScorerModel] = useState<ModelConfig>(emptyModelConfig());
  // The scoring model inherits the optimization model until the user picks
  // one of its own; `scorerModel` only speaks when the mode is explicit.
  const [scorerModelMode, setScorerModelMode] = useState<ScoringModelMode>("inherit");
  const scorerUsesModel = scorerKind === "python" && scorerCallsModel(metricCode);
  const [dryRun, setDryRun] = useState<DryRunState>({ status: "idle" });
  const dryRunAttemptRef = useRef(0);
  const updateScorerSecret = useCallback((value: string) => {
    setScorerSecret(value);
  }, []);
  const [evaluatorEvidence, setEvaluatorEvidence] = useState<ValidationEvidence | null>(null);

  const validationAttemptRef = useRef(0);
  const navigationRevisionRef = useRef(0);
  const mountedRef = useRef(true);
  const validationToastRef = useRef<ValidationToast | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      navigationRevisionRef.current += 1;
      validationToastRef.current?.dismiss();
    };
  }, []);

  const [strategyMode, setStrategyMode] = useState<"auto" | "single" | "plateau">("auto");
  const [engine, setEngine] = useState<BlackboxEngineId | null>(null);
  const proposerRuntime = "vercel" as const;
  const [patience, setPatience] = useState(DEFAULT_PATIENCE);
  const [engineCatalogResult, setEngineCatalogResult] = useState<{
    target: BlackboxTarget["kind"];
    data: BlackboxEngineCatalogResponse | null;
  } | null>(null);
  const currentCatalogResult =
    engineCatalogResult?.target === targetKind ? engineCatalogResult : null;
  const engineCatalog = currentCatalogResult?.data ?? null;
  const engineCatalogFailed = currentCatalogResult !== null && engineCatalog === null;
  const [maxScorerRuns, setMaxScorerRuns] = useState(DEFAULT_MAX_SCORER_RUNS);
  const [maxIterations, setMaxIterations] = useState<number | "">("");
  const [stopAtScore, setStopAtScore] = useState("");
  const [reflectionModel, setReflectionModel] = useState<ModelConfig>(emptyModelConfig());
  const nativeProposer = usesNativeProposer(strategyMode, engine);
  const iterationLimitSupported = supportsIterationLimit(strategyMode, engine);
  const effectiveReflectionModel = useMemo(
    () => proposerModelConfig(reflectionModel, nativeProposer),
    [reflectionModel, nativeProposer],
  );
  const [editingModel, setEditingModel] = useState<{
    config: ModelConfig;
    onSave: (c: ModelConfig) => void;
    label: string;
    nameOnly?: boolean;
    modelDefaultsOnly?: boolean;
  } | null>(null);
  const {
    maxCostCredits,
    setMaxCostCredits,
    session: budgetSession,
    setupSpent,
    availableCredits,
  } = useExecutionBudget();

  const drafts = useWizardDrafts();
  const draftsRef = useRef(drafts);
  useEffect(() => {
    draftsRef.current = drafts;
  }, [drafts]);
  // Taken once at mount: the saved draft this instance hydrates from, or null
  // when the form starts blank. Publishing waits until that hydration has
  // landed so the first snapshot written is the restored one, not the empty
  // initial state.
  const [draftSnapshot] = useState(() => drafts.takeSnapshot("anything"));
  const hydratedRef = useRef(false);
  const submittedRef = useRef(false);

  // Shared wizard-state bridge (see use-submit-wizard): the panel agent's
  // recipe-independent fields land here, and local edits go back so the agent
  // sees the form it is talking about. The seed, target, scorer and optimizer
  // are authored in-wizard and stay local.
  const wizardCtx = useWizardStateOptional();
  const wizardCtxRef = useRef(wizardCtx);
  useEffect(() => {
    wizardCtxRef.current = wizardCtx;
  }, [wizardCtx]);
  const agentPulseTick = wizardCtx?.agentPulseTick ?? 0;
  useEffect(() => {
    const shared = wizardCtx?.state;
    const keys = wizardCtx?.agentPulseKeys ?? [];
    if (!shared || keys.length === 0) return;
    for (const key of keys) {
      if (key === "job_name" && typeof shared.job_name === "string") {
        // An agent-given name is decided: the suggestion must not overwrite it.
        setJobName(shared.job_name);
        setJobNameTouched(true);
      } else if (key === "job_description" && typeof shared.job_description === "string") {
        setJobDescription(shared.job_description);
      } else if (key === "is_private" && typeof shared.is_private === "boolean") {
        setIsPrivate(shared.is_private);
      } else if (key === "split_fractions" && shared.split_fractions) {
        setSplit(shared.split_fractions);
      } else if (
        key === "split_mode" &&
        (shared.split_mode === "auto" || shared.split_mode === "manual")
      ) {
        splitModeRef.current = shared.split_mode;
        setSplitModeState(shared.split_mode);
      } else if (key === "seed" && typeof shared.seed === "number") {
        setSeed(shared.seed);
      } else if (key === "shuffle" && typeof shared.shuffle === "boolean") {
        setShuffle(shared.shuffle);
      }
    }
    // Runs once per agent pulse; the keys and state are read from that render.
  }, [agentPulseTick]);
  useEffect(() => {
    if (!wizardCtx) return;
    const s = wizardCtx.state;
    if (s.job_name !== jobName) wizardCtx.setField("job_name", jobName, "user");
    if (s.job_description !== jobDescription) {
      wizardCtx.setField("job_description", jobDescription, "user");
    }
    if (s.is_private !== isPrivate) wizardCtx.setField("is_private", isPrivate, "user");
    if (s.split_mode !== splitMode) wizardCtx.setField("split_mode", splitMode, "user");
    if (s.seed !== seed) wizardCtx.setField("seed", seed, "user");
    if (s.shuffle !== shuffle) wizardCtx.setField("shuffle", shuffle, "user");
    const sf = s.split_fractions;
    if (!sf || sf.train !== split.train || sf.val !== split.val || sf.test !== split.test) {
      wizardCtx.setField("split_fractions", split, "user");
    }
  }, [wizardCtx, jobName, jobDescription, isPrivate, splitMode, seed, shuffle, split]);
  // The draft's stage is applied one render after its fields, so the
  // prerequisite walk (below validateStep) checks the restored state rather
  // than the empty initial one.
  const [pendingRestore, setPendingRestore] = useState<{
    stage: WizardStageId;
    furthest: WizardStageId;
  } | null>(null);
  useEffect(() => {
    const d = draftSnapshot;
    if (!d) {
      hydratedRef.current = true;
      return;
    }
    setPendingRestore({ stage: d.stage, furthest: d.furthestStage });
    setJobName(d.jobName);
    setJobNameTouched(d.jobName.trim() !== "" && d.jobName !== suggestedRunName(d.objective));
    setJobDescription(d.jobDescription);
    setIsPrivate(d.isPrivate);
    setRecipeState(d.recipe);
    setCodeAssistMode(d.codeAssistMode);
    setSeedMode(d.seedMode);
    setSeedText(d.seedText);
    setSeedParts(d.seedParts);
    setSeedManuallyEdited(
      d.seedManuallyEdited ||
        !!d.seedText.trim() ||
        d.seedParts.some((part) => !!part.value.trim()),
    );
    setScorerManuallyEdited(d.scorerManuallyEdited || !!d.metricCode.trim());
    setObjective(d.objective);
    setBackground(d.background);
    setTargetKind(d.targetKind);
    setHarness(d.harness);
    setTargetModel(d.targetModel);
    setTargetTimeout(d.targetTimeout);
    setTargetConcurrency(d.targetConcurrency);
    setParsedCases(d.parsedCases);
    setCasesName(d.casesName);
    splitModeRef.current = d.splitMode;
    setSplitModeState(d.splitMode);
    setSplit(d.split);
    setShuffle(d.shuffle);
    setSeed(d.seed);
    setScorerKind(d.scorerKind);
    setMetricCode(d.metricCode);
    setScorerUrl(d.scorerUrl);
    setScorerInstall(d.scorerInstall);
    setScorerPackages(d.scorerPackages ?? "");
    setScorerDependencyLock(d.scorerDependencyLock ?? null);
    setScorerModel(d.scorerModel);
    setScorerModelMode(d.scorerModelMode);
    setStrategyMode(d.strategyMode);
    setEngine(d.engine);
    setPatience(d.patience);
    setMaxScorerRuns(d.maxScorerRuns);
    setMaxIterations(d.maxIterations);
    setStopAtScore(d.stopAtScore);
    setReflectionModel(d.reflectionModel);
  }, [draftSnapshot]);

  // Auto and Plateau relay pick engines themselves, so only a hand-picked engine
  // shapes the recommended split.
  useDatasetProfiling({
    parsedDataset: parsedCases,
    columnRoles: caseColumnRoles,
    splitModeRef,
    setSplitPlan,
    setProfileLoading,
    setSplit,
    setShuffle,
    setSeed,
    engine: strategyMode === "single" ? engine : null,
  });

  useEffect(() => {
    let cancelled = false;
    getBlackboxEngines(targetKind)
      .then((res) => {
        if (!cancelled) setEngineCatalogResult({ target: targetKind, data: res });
      })
      .catch(() => {
        if (!cancelled) setEngineCatalogResult({ target: targetKind, data: null });
      });
    return () => {
      cancelled = true;
    };
  }, [targetKind]);

  // A `?clone=` link hydrates the wizard from the source run's stored payload
  // (server-scrubbed: no model api_key, no remote-scorer secret). The clone
  // link only preselects the picker; the recipe kind, seed, cases, scorer and
  // optimizer all come from the payload.
  const cloneRan = useRef(false);
  const [cloned, setCloned] = useState(false);
  const [issue, setIssue] = useState<WizardIssue | null>(null);
  useEffect(() => {
    const cloneId = searchParams.get("clone");
    // A restored draft owns the form; the clone URL it was continued past must
    // not hydrate over it.
    if (!cloneId || cloneRan.current || draftSnapshot) return;
    cloneRan.current = true;
    Promise.all([getOptimizationPayload(cloneId), getJob(cloneId).catch(() => null)])
      .then(([{ optimization_type, payload }, jobData]) => {
        // A Program run cloned into this wizard (the picker lets the user
        // switch recipe) brings its basics and rows as cases; the seed,
        // target, scorer and optimizer only exist on an Anything run.
        const stored = payload as Record<string, unknown>;
        const source =
          cloneSourceRecipe(optimization_type) === "anything"
            ? (payload as Partial<BlackboxRunRequest>)
            : null;
        const basics = cloneBasics(stored, jobData?.name);
        // A cloned run's name is decided; the suggestion must not replace it
        // once the cloned objective lands.
        if (basics.name) {
          setJobName(basics.name);
          setJobNameTouched(true);
        }
        if (basics.description) setJobDescription(basics.description);
        if (basics.isPrivate != null) setIsPrivate(basics.isPrivate);

        if (source) {
          if (source.recipe) setRecipeState(wizardRecipe(source.recipe));
          if (source.objective) setObjective(source.objective);
          if (source.background) setBackground(source.background);

          const seed = source.seed_candidate;
          if (typeof seed === "string") {
            setSeedMode("text");
            setSeedText(seed);
          } else if (seed && typeof seed === "object") {
            setSeedMode("parts");
            setSeedParts(Object.entries(seed).map(([key, value]) => ({ key, value })));
          } else {
            setSeedMode("none");
          }
          // Cloned artifacts are decided: the agent's unprompted passes must not
          // redraft them.
          setSeedManuallyEdited(true);
          setScorerManuallyEdited(true);

          const target = source.target;
          if (target) {
            setTargetKind(target.kind);
            // A cloned job may name a harness the wizard no longer offers
            // ("custom"); the select can't show it, so the default stays.
            if (target.harness && BLACKBOX_HARNESSES.includes(target.harness))
              setHarness(target.harness);
            if (source.task_model_config?.name) {
              setTargetModel({ ...emptyModelConfig(), ...source.task_model_config });
            } else if (target.model) {
              setTargetModel({ name: target.model });
            }
            if (target.timeout_seconds != null) setTargetTimeout(target.timeout_seconds);
            if (target.concurrency != null) setTargetConcurrency(target.concurrency);
          }
        }

        const rows = cloneRows(stored);
        if (rows) {
          setParsedCases(rows);
          setCasesName(String(basics.name || cloneId));
        }
        if (basics.split) {
          setSplit({ ...defaultSplit, ...basics.split });
          // Cloned splits are intentional — pin the wizard to manual so the
          // profiling effect doesn't clobber them when the cases reload.
          splitModeRef.current = "manual";
          setSplitModeState("manual");
        }
        if (basics.shuffle != null) setShuffle(basics.shuffle);
        if (basics.seed != null) setSeed(basics.seed);

        if (source) {
          const scorer = source.scorer;
          if (scorer) {
            setScorerKind(scorer.kind);
            if (scorer.metric_code) setMetricCode(scorer.metric_code);
            if (scorer.dependency_lock) {
              setScorerDependencyLock(scorer.dependency_lock);
              setScorerPackages(scorer.dependency_lock.requirements.join("\n"));
            }
            if (scorer.url) setScorerUrl(scorer.url);
            if (scorer.kind === "python" && scorer.install_command)
              setScorerInstall(scorer.install_command);
            // A stored scorer model is an explicit choice even when it matches
            // the optimization model: the field alone cannot say it was inherited.
            if (scorer.kind === "python" && scorer.model?.name) {
              setScorerModel({ ...emptyModelConfig(), ...scorer.model });
              setScorerModelMode("explicit");
            }
          }

          const strategy = source.strategy;
          if (strategy) {
            setStrategyMode(strategy.mode);
            setEngine(strategy.engine ?? null);
            if (strategy.patience != null) setPatience(strategy.patience);
          }
          const budget = source.budget;
          if (budget) {
            if (budget.max_scorer_runs != null) setMaxScorerRuns(budget.max_scorer_runs);
            setMaxIterations(budget.max_iterations ?? "");
            setStopAtScore(budget.stop_at_score == null ? "" : String(budget.stop_at_score));
          }
          if (source.max_cost_credits != null) setMaxCostCredits(source.max_cost_credits);
        }
        // Both recipes store the reflection model the same way.
        const reflection = stored.reflection_model_config as ModelConfig | undefined;
        if (reflection?.name) setReflectionModel({ ...emptyModelConfig(), ...reflection });
        // A Program run's seed still has to be drafted here, so only an
        // Anything clone rules the interview out.
        setCloned(source != null);
        // A full clone is a decided setup: open the summary with every
        // earlier stage unlocked instead of walking the questions it already
        // answered. The restore walk still stops at a stage that no longer
        // validates, so a stale clone lands where it needs repair.
        if (source) setPendingRestore({ stage: "review", furthest: "review" });
        toast.success(msg("submit.clone.success"));
      })
      .catch(() => {
        toast.error(msg("submit.clone.failed"));
      });
  }, [searchParams]);

  // What the seed reads as, latched until the seed is cleared so the editor
  // never swaps out from under the caret while a snippet is typed or trimmed.
  // The kind follows the same reading, so an agent-written seed and a pasted
  // one land on the same scorer template.
  const seedSample = seedMode === "text" ? seedText : seedParts.map((p) => p.value).join("\n");
  const [seedGuess, setSeedGuess] = useState<SeedGuess>(NO_GUESS);
  useEffect(() => {
    if (!seedSample.trim()) {
      setSeedGuess(NO_GUESS);
      return;
    }
    const language = detectLanguage(seedSample);
    const code = language !== null || looksLikeCode(seedSample);
    if (code) {
      setSeedGuess((prev) =>
        prev.code && (!language || prev.language === language)
          ? prev
          : { code: true, language: language ?? prev.language },
      );
    }
    if (seedMode === "none") return;
    const detected: BlackboxRecipe = code || seedGuess.code ? "code" : "anything";
    if (detected !== recipe) setRecipe(detected);
  }, [seedSample, seedMode, seedGuess.code, recipe, setRecipe]);
  const seedIsCode = recipe === "code" || seedGuess.code;

  const seedCandidate = useMemo<BlackboxCandidate | null>(() => {
    if (seedMode === "none") return null;
    if (seedMode === "text") return seedText.trim() ? seedText : null;
    const parts = seedParts.filter((p) => p.key.trim() && p.value.trim());
    return parts.length ? Object.fromEntries(parts.map((p) => [p.key.trim(), p.value])) : null;
  }, [seedMode, seedText, seedParts]);

  const scoringBinding = useMemo(
    () =>
      resolveScoringModel({
        usesModel: scorerUsesModel,
        mode: scorerModelMode,
        explicit: scorerModel,
        optimization: effectiveReflectionModel,
      }),
    [scorerUsesModel, scorerModelMode, scorerModel, effectiveReflectionModel],
  );
  const resolvedScorerModel = scoringBinding?.resolved ?? null;
  // Inherited from an optimization model not chosen yet: the evaluator check
  // waits until the user leaves Optimization instead of failing here.
  const scoringModelPending = scoringBinding?.pending ?? false;

  const buildScorer = useCallback(
    (code: string = metricCode): BlackboxScorer =>
      scorerKind === "python"
        ? {
            kind: "python",
            metric_code: code,
            timeout_seconds: SCORER_TIMEOUT_SECONDS,
            install_command: scorerInstall.trim() || null,
            dependency_lock: scorerDependencyLock,
            model:
              scorerCallsModel(code) && resolvedScorerModel?.name.trim()
                ? prepareModelConfig(resolvedScorerModel)
                : null,
          }
        : {
            kind: "remote",
            url: scorerUrl.trim(),
            secret: scorerSecret.trim() || undefined,
            timeout_seconds: SCORER_TIMEOUT_SECONDS,
          },
    [
      scorerKind,
      metricCode,
      scorerUrl,
      scorerSecret,
      scorerInstall,
      scorerDependencyLock,
      resolvedScorerModel,
    ],
  );

  const buildTarget = (): BlackboxTarget =>
    targetKind === "text"
      ? { kind: "text" }
      : {
          kind: "agent",
          harness,
          model: targetModel.name.trim(),
          timeout_seconds: targetTimeout,
          concurrency: targetConcurrency,
        };

  const costBracket: CostBracket = useMemo(() => {
    const findModel = (config: ModelConfig) =>
      config.name.trim()
        ? (catalog?.models.find((candidate) => candidate.value === config.name) ?? null)
        : null;
    const modelRoles: ProjectedModelRole[] = [
      {
        role: "optimization",
        model: findModel(effectiveReflectionModel),
        tokenSource: effectiveReflectionModel.token_source ?? "managed",
        tokenShare: 1,
      },
      ...(targetKind === "agent" && targetModel.name.trim()
        ? [
            {
              role: "task" as const,
              model: findModel(targetModel),
              tokenSource: targetModel.token_source ?? "managed",
              tokenShare: 1,
            },
          ]
        : []),
      ...(scorerUsesModel && resolvedScorerModel?.name.trim()
        ? [
            {
              role: "judge" as const,
              model: findModel(resolvedScorerModel),
              tokenSource: resolvedScorerModel.token_source ?? "managed",
              tokenShare: 1,
            },
          ]
        : []),
    ];
    const selectedRuntime = engineCatalog?.proposer_runtimes.find(
      (runtime) => runtime.id === proposerRuntime,
    );
    // Two readiness checks, the run, and Python package resolution have separate coverage.
    return projectCostBracket({
      autoLevel: "",
      maxFullEvals: "",
      maxMetricCalls: String(maxScorerRuns),
      datasetRows: Math.max(1, parsedCases?.rowCount ?? 0),
      modelRoles,
      runtime: runtimeCostProjection(selectedRuntime?.cost, scorerKind === "python" ? 4 : 3),
    });
  }, [
    effectiveReflectionModel,
    targetKind,
    targetModel,
    scorerUsesModel,
    resolvedScorerModel,
    catalog,
    engineCatalog,
    maxScorerRuns,
    scorerKind,
    parsedCases?.rowCount,
  ]);
  const tokenSource = aggregateTokenSource([
    effectiveReflectionModel,
    ...(targetKind === "agent" ? [targetModel] : []),
    ...(scorerUsesModel && resolvedScorerModel ? [resolvedScorerModel] : []),
  ]);
  const suggestedCeiling = useMemo(
    () => defaultCeilingForBracket(chargeableBracket(costBracket, tokenSource)),
    [costBracket, tokenSource],
  );

  const buildSubmissionPayload = (overrideCode?: string): BlackboxRunRequest => {
    const reflection = prepareModelConfig(effectiveReflectionModel);
    const estimate = chargeableBracket(costBracket, tokenSource);
    return {
      name: jobName.trim() || suggestedRunName(objective) || undefined,
      description: jobDescription.trim() || undefined,
      username,
      objective: objective.trim() || undefined,
      background: background.trim() || undefined,
      recipe,
      seed_candidate: seedCandidate ?? undefined,
      scorer: buildScorer(overrideCode),
      cases: parsedCases?.rows,
      split_fractions: split,
      shuffle,
      seed,
      budget: {
        max_scorer_runs: maxScorerRuns,
        max_iterations: iterationLimitSupported && maxIterations !== "" ? maxIterations : undefined,
        stop_at_score: parseOptionalNumber(stopAtScore),
      },
      strategy:
        strategyMode === "single"
          ? { mode: "single", engine }
          : strategyMode === "plateau"
            ? { mode: "plateau", patience }
            : { mode: "auto" },
      proposer_runtime: proposerRuntime,
      target: buildTarget(),
      task_model_config: targetKind === "agent" ? prepareModelConfig(targetModel) : undefined,
      reflection_model_config: reflection,
      token_source: tokenSource,
      is_private: isPrivate,
      max_cost_credits: maxCostCredits ?? undefined,
      estimated_credits_low: estimate.lowCredits,
      estimated_credits_high: estimate.highCredits,
    };
  };

  const preflight = useWizardPreflight("anything", buildSubmissionPayload(), budgetSession);
  const evaluationCheck = preflight.evidence.evaluation;
  const executionCheck = preflight.evidence.execution;
  const currentCheck =
    executionCheck?.identity === preflight.identity ? executionCheck : evaluationCheck;
  const evaluatorStatus: EvidenceStatus =
    preflight.running.evaluation === preflight.identity ||
    preflight.running.execution === preflight.identity
      ? "running"
      : preflight.error
        ? "failed"
        : currentCheck
          ? currentCheck.identity !== preflight.identity
            ? "stale"
            : currentCheck.response.status === "succeeded"
              ? "passed"
              : currentCheck.response.status === "failed"
                ? "failed"
                : "idle"
          : "idle";
  useEffect(() => {
    if (evaluatorStatus === "stale") setScorerValidation(null);
  }, [evaluatorStatus]);

  const performDryRun = useCallback(
    async (overrideCode?: string, scope: PreflightScope = "evaluation") => {
      const attempt = ++dryRunAttemptRef.current;
      const navigation = navigationRevisionRef.current;
      const requestPayload = buildSubmissionPayload(overrideCode);
      const initialIdentity = preflight.identity;
      let completed: WizardPreflightResponse | null | undefined;
      setDryRun({ status: "running" });
      try {
        if (requestPayload.scorer.kind === "python") {
          const code = requestPayload.scorer.metric_code ?? "";
          const requirements = scorerPackages
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);
          const digest = Array.from(
            new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code))),
          )
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("");
          const lock = requestPayload.scorer.dependency_lock;
          if (
            !lock ||
            lock.code_sha256 !== digest ||
            JSON.stringify(lock.requirements) !== JSON.stringify(requirements)
          ) {
            const currentBudget = await budgetSession.ensure();
            const resolved = await resolveScorerDependencies({
              code,
              requirements,
              execution_budget_id: currentBudget.id,
              execution_budget_revision: currentBudget.revision,
            });
            await budgetSession.adopt(resolved.budget);
            if (
              !mountedRef.current ||
              attempt !== dryRunAttemptRef.current ||
              navigation !== navigationRevisionRef.current ||
              !preflight.isCurrent(initialIdentity)
            ) {
              throw new DOMException("Dependency resolution superseded", "AbortError");
            }
            if (!resolved.ok || !resolved.dependency_lock) {
              throw new Error(
                resolved.error ??
                  msg(
                    resolved.preview_status === "pending"
                      ? "submit.preflight.usage_pending"
                      : "submit.preflight.failed",
                  ),
              );
            }
            requestPayload.scorer.dependency_lock = resolved.dependency_lock;
            setScorerDependencyLock(resolved.dependency_lock);
          }
        }
        const requestIdentity = preflightIdentity("anything", requestPayload);
        completed = preflight.reusable(scope, requestPayload);
        const response = completed ?? (await preflight.run(scope, requestPayload));
        const error =
          response.checks.find((check) => check.status === "failed")?.message ??
          (response.status === "failed" ? msg("submit.preflight.failed") : null);
        const evidence: ValidationEvidence = {
          identity: requestIdentity,
          ok: response.status === "succeeded",
          error,
          checkedAt: Date.now(),
          modelName: scorerUsesModel ? (resolvedScorerModel?.name ?? null) : null,
          creditsCharged: response.scorer_result?.credits_charged,
        };
        const outcome: ValidationResult | null =
          response.status === "pending"
            ? null
            : {
                valid: response.status === "succeeded",
                errors: error ? [error] : [],
                warnings: [],
              };
        if (
          mountedRef.current &&
          attempt === dryRunAttemptRef.current &&
          navigation === navigationRevisionRef.current &&
          preflight.isCurrent(evidence.identity)
        ) {
          setDryRun(
            response.scorer_result
              ? { status: "done", result: response.scorer_result }
              : { status: "idle" },
          );
          setEvaluatorEvidence(evidence);
          setScorerValidation(outcome);
        }
        return { response, evidence, outcome };
      } finally {
        if (!completed && mountedRef.current && attempt === dryRunAttemptRef.current)
          setDryRun((current) => (current.status === "running" ? { status: "idle" } : current));
      }
    },
    [
      preflight,
      buildSubmissionPayload,
      scorerUsesModel,
      resolvedScorerModel,
      scorerPackages,
      budgetSession,
    ],
  );
  const runDryRun = useCallback(
    async (overrideCode?: string): Promise<ValidationResult | null> => {
      try {
        return (await performDryRun(overrideCode)).outcome;
      } catch (error) {
        if (!mountedRef.current) return null;
        setDryRun({ status: "idle" });
        const message = error instanceof Error ? error.message : msg("submit.preflight.failed");
        return {
          valid: false,
          errors: [message.startsWith("budget.") ? msg(message as MessageKey) : message],
          warnings: [],
        };
      }
    },
    [performDryRun],
  );

  const authoringContext = useMemo<BlackboxAuthoringContext>(
    () => ({
      recipe,
      objective,
      background,
      target_kind: targetKind,
      scorer_has_model: scorerUsesModel && (resolvedScorerModel?.name.trim().length ?? 0) > 0,
    }),
    [recipe, objective, background, targetKind, scorerUsesModel, resolvedScorerModel],
  );

  // Restored or cloned authored artifacts must survive the first render before hydration.
  const interviewPossible =
    codeAssistMode === "auto" &&
    !cloned &&
    !seedManuallyEdited &&
    !scorerManuallyEdited &&
    !(
      draftSnapshot &&
      (draftSnapshot.seedText.trim() ||
        draftSnapshot.metricCode.trim() ||
        draftSnapshot.seedParts.some((part) => part.value.trim()))
    );
  // The interview opens on the Goal stage, the wizard's first — drafting the
  // seed is its job, so it never waits for a typed objective. The seed pass
  // runs when it resolves, so the user leaves the stage with a drafted
  // starting point instead of having to write one.
  const interviewEligible = interviewPossible;
  const interview = useCodeInterview({
    enabled: interviewEligible,
    parsedDataset: parsedCases,
    columnRoles: NO_ROLES,
    columnKinds: NO_KINDS,
    jobModel: targetKind === "agent" ? targetModel.name : reflectionModel.name,
    blackbox: authoringContext,
  });
  // Over a blank objective the interviewer asks for it first and reports the
  // answer; the field takes it so the agent and submit validation see one.
  // A typed objective always wins.
  useEffect(() => {
    if (!interview.objective) return;
    setObjective((prev) => (prev.trim().length > 0 ? prev : interview.objective));
  }, [interview.objective]);
  // The confirmed brief is the interview's reading of what matters; it lands
  // in Background so the run and the drafting agent work from the same
  // constraints. Typed background always wins.
  useEffect(() => {
    if (interview.confirmedBrief.length === 0) return;
    setBackground((prev) =>
      prev.trim().length > 0
        ? prev
        : interview.confirmedBrief.map((line) => `- ${line}`).join("\n"),
    );
  }, [interview.confirmedBrief]);
  // Resolving the interview (confirm or skip) is an explicit ask to draft, so
  // it lifts the hand-edit guard: a starting point typed while the interview
  // was open reaches the seed pass as the prior to build on.
  useEffect(() => {
    if (!interview.resolved) return;
    setSeedManuallyEdited(false);
    setScorerManuallyEdited(false);
  }, [interview.resolved]);

  const agentSetSeed = useCallback((code: string) => {
    setSeedText(code);
    setSeedMode("text");
  }, []);
  const noSeedValidation = useCallback(async () => null, []);
  const agent = useCodeAgent({
    codeAssistMode,
    setCodeAssistMode,
    columnRoles: NO_ROLES,
    columnKinds: NO_KINDS,
    parsedDataset: parsedCases,
    moduleName: "",
    signatureCode: seedText,
    metricCode,
    setSignatureCode: agentSetSeed,
    setMetricCode,
    signatureManuallyEdited: seedManuallyEdited,
    metricManuallyEdited: scorerManuallyEdited,
    setSignatureManuallyEdited: setSeedManuallyEdited,
    setMetricManuallyEdited: setScorerManuallyEdited,
    setSignatureValidation: setSeedValidation,
    setMetricValidation: setScorerValidation,
    signatureValidation: seedValidation,
    metricValidation: scorerValidation,
    runSignatureValidation: noSeedValidation,
    runMetricValidation: noSeedValidation,
    seedEnabled: interview.resolved,
    interviewBrief: interview.confirmedBrief,
    blackbox: authoringContext,
    model: interview.model,
    reasoningEffort: interview.reasoningEffort,
  });

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setParsedCases(await parseDatasetFile(file));
      setCasesName(file.name);
    } catch {
      toast.error(msg("submit.dataset.file_error"));
    }
  };

  const handlePickFromLibrary = async (dataset: DatasetSummary) => {
    setLibraryOpen(false);
    try {
      const res = await getDatasetRows(dataset.id);
      setParsedCases({
        columns: res.columns.length > 0 ? res.columns : Object.keys(res.rows[0] ?? {}),
        rows: res.rows,
        rowCount: res.row_count,
      });
      setCasesName(dataset.name);
    } catch {
      toast.error(msg("submit.dataset.file_error"));
    }
  };

  const clearCases = () => {
    setParsedCases(null);
    setCasesName("");
  };

  const selectedEngine = engineCatalog?.engines.find((e) => e.id === engine) ?? null;
  const trainingCaseCount = parsedCases?.rows.length
    ? Math.floor(parsedCases.rows.length * split.train)
    : null;
  const autoEngineLabels = useMemo<string[]>(
    () =>
      (engineCatalog?.auto_engines ?? []).map(
        (id) => engineCatalog?.engines.find((e) => e.id === id)?.label ?? id,
      ),
    [engineCatalog],
  );
  const runDisabledReason = useMemo<string | null>(() => {
    if (engineCatalogFailed) return msg("submit.blackbox.engines.check_failed");
    const issue = engineSelectionIssue({
      catalog: engineCatalog,
      mode: strategyMode,
      engine,
      hasParts: seedMode === "parts",
      trainingCaseCount,
    });
    return issue ? msg(issue.key, issue.params) : null;
  }, [engineCatalog, engineCatalogFailed, strategyMode, engine, seedMode, trainingCaseCount]);
  const optimizationFamily = optimizationModelFamily(strategyMode, engine);

  /** The first problem holding a stage back, or null when it validates. */
  const stageIssue = (s: number): WizardIssue | null => {
    const fail = (key: MessageKey, fieldId?: string): WizardIssue => ({
      stage: stageAt(s),
      fieldId,
      message: msg(key),
    });
    switch (s) {
      case WIZARD_STAGE.goal: {
        const partsIssue = seedMode === "parts" ? seedPartsIssue(seedParts) : null;
        if (partsIssue) return fail(`submit.parts.${partsIssue}`, "bb-seed");
        // In auto mode the agent drafts the text seed from the objective, so
        // the objective is the required input and the seed may stay blank.
        const agentDrafts = codeAssistMode === "auto" && seedMode === "text";
        if ((seedMode === "none" || agentDrafts) && !objective.trim())
          return fail("submit.blackbox.validation.objective_required", "bb-objective");
        if (seedMode !== "none" && !agentDrafts && seedCandidate == null)
          return fail("submit.blackbox.validation.seed_required", "bb-seed");
        return null;
      }
      case WIZARD_STAGE.evaluation: {
        if (maxCostCredits == null) return fail("budget.invalid", "totalBudgetInput");
        if (targetKind === "agent") {
          if (!parsedCases?.rowCount)
            return fail("submit.blackbox.validation.cases_required", "bb-cases");
          if (!targetModel.name.trim())
            return fail("submit.blackbox.validation.agent_model_required", "bb-task-model");
        }
        if (scorerKind === "python" && !metricCode.trim())
          return fail("submit.blackbox.validation.scorer_code_required", "bb-scorer-code");
        if (scorerUsesModel && scorerModelMode === "explicit" && !scorerModel.name.trim())
          return fail("submit.blackbox.validation.scorer_model_required", "bb-scoring-model");
        if (scorerKind === "remote" && !/^https?:\/\/\S+$/.test(scorerUrl.trim()))
          return fail("submit.blackbox.validation.scorer_url_required", "bb-scorer-url");
        if (parsedCases && Math.abs(split.train + split.val + split.test - 1) > 0.001)
          return fail("submit.blackbox.validation.split_sum", "bb-split");
        return null;
      }
      case WIZARD_STAGE.optimization: {
        if (trainingCaseCount === 0 && (strategyMode !== "single" || engine === "meta_harness"))
          return fail("submit.blackbox.validation.training_cases", "bb-cases");
        // Availability is not a validation failure: an unavailable engine is a
        // configuration state that holds Run back with its reason.
        if (strategyMode === "single") {
          if (!engine || (engineCatalog && !selectedEngine))
            return fail("submit.blackbox.validation.engine_required", "bb-engines");
          if (seedMode === "parts" && selectedEngine && !selectedEngine.supports_parts)
            return fail("submit.blackbox.validation.engine_parts", "bb-engines");
        } else if (seedMode === "parts") {
          return fail("submit.blackbox.validation.auto_parts", "bb-engines");
        }
        if (!reflectionModel.name.trim())
          return fail(
            "submit.blackbox.validation.reflection_model_required",
            "bb-optimization-model",
          );
        if (nativeProposer && maxCostCredits == null)
          return fail("submit.blackbox.validation.native_budget", "totalBudgetInput");
        if (strategyMode === "auto" && maxScorerRuns < 4)
          return fail("submit.blackbox.validation.auto_budget", "bb-max-runs");
        if (maxScorerRuns < 1)
          return fail("submit.blackbox.validation.budget_required", "bb-max-runs");
        return null;
      }
      default:
        return null;
    }
  };

  /** Validates a stage; `report` records its first problem for inline display. */
  const validateStep = (s: number, report = false): boolean => {
    const found = stageIssue(s);
    if (found && report) setIssue(found);
    return found == null;
  };

  // Walk the restored stage's prerequisites against the restored state: a
  // saved stage whose earlier stages no longer validate opens on the first
  // failing one instead. Publishing starts here, after the restored fields
  // have landed.
  useEffect(() => {
    if (!pendingRestore) return;
    setPendingRestore(null);
    hydratedRef.current = true;
    const target = WIZARD_STAGE[pendingRestore.stage];
    let reachable = 0;
    while (reachable < target && validateStep(reachable)) reachable += 1;
    setStep(reachable);
    setFurthestReachedStep(Math.max(reachable, WIZARD_STAGE[pendingRestore.furthest]));
  }, [pendingRestore, validateStep]);

  const goTo = (idx: number) => {
    navigationRevisionRef.current += 1;
    dryRunAttemptRef.current += 1;
    setDryRun((current) => (current.status === "running" ? { status: "idle" } : current));
    preflight.cancel();
    validationToastRef.current?.dismiss();
    setDirection(idx > step ? 1 : -1);
    setStep(idx);
    setFurthestReachedStep((prev) => Math.max(prev, idx));
  };
  const goPrev = () => {
    if (step > 0) goTo(step - 1);
  };

  const ensureEvaluatorChecked = async (
    scope: PreflightScope,
  ): Promise<WizardPreflightResponse | null> => {
    const completed = preflight.reusable(scope);
    if (completed) return completed;
    const navigation = navigationRevisionRef.current;
    let identity = preflight.identity;
    const t = beginValidationToast(
      toast,
      `wizard-validate-${++validationAttemptRef.current}`,
      msg("submit.validation.toast.running"),
    );
    validationToastRef.current = t;
    try {
      const { response, evidence } = await performDryRun(undefined, scope);
      identity = evidence.identity;
      if (
        !mountedRef.current ||
        navigation !== navigationRevisionRef.current ||
        !preflight.isCurrent(evidence.identity)
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
        return null;
      }
      const failure = response.checks.find((check) => check.status === "failed");
      t.fail(failure?.message ?? msg("submit.preflight.failed"));
      const destination = preflightDestination("anything", failure?.field ?? failure?.key, scope);
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
          goTo(WIZARD_STAGE.evaluation);
          setIssue({
            stage: "evaluation",
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
  const advance = async (target: number) => {
    if (advancingRef.current) return;
    advancingRef.current = true;
    setAdvancing(true);
    setIssue(null);
    try {
      for (let i = 0; i < target; i++) {
        if (!validateStep(i, true)) {
          goTo(i);
          return;
        }
      }
      if (
        target > WIZARD_STAGE.evaluation &&
        !(await ensureEvaluatorChecked(
          target > WIZARD_STAGE.optimization ? "execution" : "evaluation",
        ))
      )
        return;
      goTo(target);
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

  // Suggested from the objective without a paid call; a typed or cloned name
  // always wins.
  const suggestedName = useMemo(() => suggestedRunName(objective), [objective]);
  useEffect(() => {
    if (!jobNameTouched) setJobName(suggestedName);
  }, [jobNameTouched, suggestedName]);
  const editJobName = useCallback((value: string) => {
    setJobNameTouched(true);
    setJobName(value);
  }, []);

  const handleSubmit = async () => {
    if (advancingRef.current || submitting) return;
    setIssue(null);
    for (let i = 0; i < LAST_WIZARD_STAGE; i++) {
      if (!validateStep(i, true)) {
        goTo(i);
        return;
      }
    }
    if (runDisabledReason) {
      toast.error(runDisabledReason);
      return;
    }
    advancingRef.current = true;
    setAdvancing(true);
    let checked: WizardPreflightResponse | null;
    try {
      checked = await ensureEvaluatorChecked("execution");
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
      const result = await submitBlackboxRun(payload, key);
      track(TelemetryEvent.BlackboxSubmitted, {
        strategy: strategyMode,
        engine: engine ?? "auto",
        target: targetKind,
        scorer: scorerKind,
        has_cases: parsedCases != null,
      });
      // The accepted job consumed the draft: nothing is re-parked while the
      // splash plays out.
      submittedRef.current = true;
      draftsRef.current.consumed();
      const jobUrl = `/optimizations/${result.optimization_id}`;
      setSubmitPhase("splash");
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

  // The draft never carries credentials: a restored BYOK model comes back
  // without its key and shows as missing credentials.
  const safeTargetModel = useMemo(() => stripModelSecrets(targetModel), [targetModel]);
  const safeScorerModel = useMemo(() => stripModelSecrets(scorerModel), [scorerModel]);
  const safeReflectionModel = useMemo(() => stripModelSecrets(reflectionModel), [reflectionModel]);
  // Every commit hands the saver the serializable snapshot; it debounces and
  // dedupes. Evidence, dry-run results and the remote secret stay out on
  // purpose so a continued draft re-runs its checks.
  useEffect(() => {
    if (!hydratedRef.current || submittedRef.current) return;
    const snapshot: AnythingDraftData = {
      stage: stageAt(step),
      furthestStage: stageAt(furthestReachedStep),
      jobName,
      jobDescription,
      isPrivate,
      recipe,
      codeAssistMode,
      seedMode,
      seedText,
      seedParts,
      seedManuallyEdited,
      scorerManuallyEdited,
      objective,
      background,
      targetKind,
      harness,
      targetModel: safeTargetModel,
      targetTimeout,
      targetConcurrency,
      parsedCases,
      casesName,
      split,
      shuffle,
      seed,
      splitMode,
      scorerKind,
      metricCode,
      scorerUrl,
      scorerInstall,
      scorerPackages,
      scorerDependencyLock,
      scorerModel: safeScorerModel,
      scorerModelMode,
      strategyMode,
      engine,
      proposerRuntime,
      patience,
      maxScorerRuns,
      maxIterations,
      stopAtScore,
      reflectionModel: safeReflectionModel,
      maxCostCredits,
      setupSpent,
    };
    draftsRef.current.publish("anything", snapshot, isMeaningfulAnythingDraft(snapshot));
  });
  // Stage boundaries are the one place the debounce is skipped: a refresh right
  // after Next lands on the stage the user just reached.
  useEffect(() => {
    if (hydratedRef.current) draftsRef.current.flush();
  }, [step]);
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

  return {
    recipe,
    setRecipe,
    step,
    direction,
    maxReachableStep: furthestReachedStep,
    advancing,
    submitting,
    submitPhase,
    validateStep,
    stageIssue,
    issue,
    goTo,
    goPrev,
    handleNext,
    handleTabClick,
    handleSubmit,
    catalog,
    recentConfigs,
    saveToRecent,
    removeRecentConfig,
    jobName,
    setJobName: editJobName,
    jobDescription,
    setJobDescription,
    isPrivate,
    setIsPrivate,
    codeAssistMode,
    setCodeAssistMode,
    seedMode,
    setSeedMode,
    seedText,
    setSeedText,
    setSeedManuallyEdited,
    setScorerManuallyEdited,
    agent,
    interview,
    interviewEligible,
    seedParts,
    setSeedParts,
    seedCandidate,
    seedIsCode,
    seedLanguage: seedGuess.language,
    objective,
    setObjective,
    background,
    setBackground,
    targetKind,
    setTargetKind,
    harness,
    setHarness,
    targetModel,
    setTargetModel,
    targetTimeout,
    setTargetTimeout,
    targetConcurrency,
    setTargetConcurrency,
    parsedCases,
    casesName,
    handleFileUpload,
    handlePickFromLibrary,
    clearCases,
    libraryOpen,
    setLibraryOpen,
    split,
    setSplit,
    updateSplit,
    splitSum,
    splitMode,
    setSplitMode,
    splitPlan,
    profileLoading,
    shuffle,
    setShuffle,
    scorerKind,
    setScorerKind,
    metricCode,
    setMetricCode,
    scorerUrl,
    setScorerUrl,
    scorerSecret,
    setScorerSecret: updateScorerSecret,
    scorerInstall,
    setScorerInstall,
    scorerPackages,
    setScorerPackages,
    scorerDependencyLock,
    setScorerDependencyLock,
    scorerModel,
    setScorerModel,
    scorerUsesModel,
    scorerModelMode,
    setScorerModelMode,
    resolvedScorerModel,
    scoringModelPending,
    scorerValidation,
    dryRun,
    runDryRun,
    evaluatorEvidence,
    evaluatorStatus,
    preflight,
    strategyMode,
    setStrategyMode,
    engine,
    setEngine,
    proposerRuntime,
    nativeProposer,
    iterationLimitSupported,
    patience,
    setPatience,
    engineCatalog,
    selectedEngine,
    autoEngineLabels,
    runDisabledReason,
    optimizationFamily,
    maxScorerRuns,
    setMaxScorerRuns,
    maxIterations,
    setMaxIterations,
    stopAtScore,
    setStopAtScore,
    reflectionModel: effectiveReflectionModel,
    setReflectionModel,
    editingModel,
    setEditingModel,
    costBracket,
    suggestedCeiling,
    tokenSource,
    maxCostCredits,
    setMaxCostCredits,
    budgetSession,
    setupSpent,
    availableCredits,
    suggestedName,
  };
}

export type BlackboxWizardContext = ReturnType<typeof useBlackboxWizard>;
