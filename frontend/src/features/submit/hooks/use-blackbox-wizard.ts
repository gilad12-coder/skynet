"use client";

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
  BlackboxTarget,
  ModelConfig,
  ScorerDryRunResponse,
  SplitFractions,
  SplitPlan,
  ValidateCodeResponse,
} from "@/shared/types/api";
import {
  dryRunScorer,
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
import { formatCredits } from "@/features/billing";
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

import { defaultSplit, emptyModelConfig, type ColumnRole } from "../constants";
import { LAST_WIZARD_STAGE, WIZARD_STAGE, stageAt, type WizardStageId } from "../lib/wizard-steps";
import { availableBudget, suggestedRunName } from "../lib/budget";
import { cloneBasics, cloneRows, cloneSourceRecipe } from "../lib/clone-payload";
import { focusField } from "../lib/focus-field";
import {
  modelIdentity,
  optimizationModelFamily,
  resolveScoringModel,
  type ScoringModelMode,
} from "../lib/model-roles";
import {
  evaluatorIdentity,
  evidenceStatus,
  type ValidationEvidence,
} from "../lib/validation-evidence";
import { beginValidationToast } from "../lib/validation-toast";
import {
  chargeableBracket,
  defaultCeilingForBracket,
  projectCostBracket,
  type CostBracket,
} from "../lib/cost-bracket";
import {
  isMeaningfulAnythingDraft,
  stripModelSecrets,
  type AnythingDraftData,
} from "../lib/draft-record";
import { useWizardDrafts } from "./use-wizard-drafts";
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
  const [jobDescription, setJobDescription] = useState("");
  const [isPrivate, setIsPrivate] = useState(true);

  // The kind of starting point — a prompt, code or any other text. Chosen in
  // the Starting point step; the picker's link only seeds it.
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
  const [targetTimeout, setTargetTimeout] = useState(600);
  const [targetConcurrency, setTargetConcurrency] = useState(2);

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
  const setRecipe = (next: BlackboxRecipe) => {
    if (metricCode === scorerTemplateFor(recipe)) setMetricCode(scorerTemplateFor(next));
    setRecipeState(next);
  };
  const [scorerUrl, setScorerUrl] = useState("");
  const [scorerSecret, setScorerSecret] = useState("");
  const [scorerInstall, setScorerInstall] = useState("");
  // A metric is any function; only one that calls `llm()` needs a model.
  // The Scorer step asks whether it does, and code that already calls
  // `llm()` answers for itself.
  const [scorerModel, setScorerModel] = useState<ModelConfig>(emptyModelConfig());
  const [scorerModelDeclared, setScorerModelDeclared] = useState(false);
  // The scoring model inherits the optimization model until the user picks
  // one of its own; `scorerModel` only speaks when the mode is explicit.
  const [scorerModelMode, setScorerModelMode] = useState<ScoringModelMode>("inherit");
  const scorerCodeCallsModel = scorerCallsModel(metricCode);
  const scorerUsesModel = scorerKind === "python" && (scorerModelDeclared || scorerCodeCallsModel);
  const [dryRun, setDryRun] = useState<DryRunState>({ status: "idle" });
  // The remote secret enters the validation identity as a revision, never as
  // its value; a passed check for one secret does not vouch for the next.
  const [secretRevision, setSecretRevision] = useState(0);
  const updateScorerSecret = useCallback((value: string) => {
    setScorerSecret(value);
    setSecretRevision((n) => n + 1);
  }, []);
  const [evaluatorEvidence, setEvaluatorEvidence] = useState<ValidationEvidence | null>(null);
  const [runningIdentity, setRunningIdentity] = useState<string | null>(null);
  // Credits the evaluator checks debited so far, shown against the total
  // budget until the server-side accounting record takes over.
  const [setupSpent, setSetupSpent] = useState(0);
  const validationAttemptRef = useRef(0);

  const [strategyMode, setStrategyMode] = useState<"auto" | "single" | "plateau">("auto");
  const [engine, setEngine] = useState<BlackboxEngineId | null>(null);
  const [patience, setPatience] = useState(DEFAULT_PATIENCE);
  const [engineCatalog, setEngineCatalog] = useState<BlackboxEngineCatalogResponse | null>(null);
  const [maxScorerRuns, setMaxScorerRuns] = useState(DEFAULT_MAX_SCORER_RUNS);
  const [maxIterations, setMaxIterations] = useState<number | "">("");
  const [stopAtScore, setStopAtScore] = useState("");
  const [reflectionModel, setReflectionModel] = useState<ModelConfig>(emptyModelConfig());
  const [editingModel, setEditingModel] = useState<{
    config: ModelConfig;
    onSave: (c: ModelConfig) => void;
    label: string;
    nameOnly?: boolean;
  } | null>(null);
  const [maxCostCredits, setMaxCostCredits] = useState<number | null>(null);

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
    setJobDescription(d.jobDescription);
    setIsPrivate(d.isPrivate);
    setRecipeState(d.recipe);
    setCodeAssistMode(d.codeAssistMode);
    setSeedMode(d.seedMode);
    setSeedText(d.seedText);
    setSeedParts(d.seedParts);
    setSeedManuallyEdited(d.seedManuallyEdited);
    setScorerManuallyEdited(d.scorerManuallyEdited);
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
    setScorerModel(d.scorerModel);
    setScorerModelDeclared(d.scorerModelDeclared);
    setScorerModelMode(d.scorerModelMode);
    setStrategyMode(d.strategyMode);
    setEngine(d.engine);
    setPatience(d.patience);
    setMaxScorerRuns(d.maxScorerRuns);
    setMaxIterations(d.maxIterations);
    setStopAtScore(d.stopAtScore);
    setReflectionModel(d.reflectionModel);
    setMaxCostCredits(d.maxCostCredits);
    setSetupSpent(d.setupSpent);
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
        if (!cancelled) setEngineCatalog(res);
      })
      .catch(() => {
        if (!cancelled) setEngineCatalog(null);
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
        if (basics.name) setJobName(basics.name);
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
            if (target.model) setTargetModel({ name: target.model });
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
            if (scorer.url) setScorerUrl(scorer.url);
            if (scorer.kind === "python" && scorer.install_command)
              setScorerInstall(scorer.install_command);
            // A stored scorer model is an explicit choice even when it matches
            // the optimization model: the field alone cannot say it was inherited.
            if (scorer.kind === "python" && scorer.model?.name) {
              setScorerModel({ ...emptyModelConfig(), ...scorer.model });
              setScorerModelDeclared(true);
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
        toast.success(msg("submit.clone.success"));
      })
      .catch(() => {
        toast.error(msg("submit.clone.failed"));
      });
  }, [searchParams]);

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
        optimization: reflectionModel,
      }),
    [scorerUsesModel, scorerModelMode, scorerModel, reflectionModel],
  );
  const resolvedScorerModel = scoringBinding?.resolved ?? null;
  // Inherited from an optimization model not chosen yet: the evaluator check
  // waits until the user leaves Optimization instead of failing here.
  const scoringModelPending = scoringBinding?.pending ?? false;

  const describeEvaluator = useCallback(
    (code: string) =>
      evaluatorIdentity({
        candidate: seedCandidate ?? objective,
        example: parsedCases?.rows[0] ?? null,
        scorer: { kind: scorerKind, code, url: scorerUrl, install: scorerInstall, secretRevision },
        scoringModel:
          scorerKind === "python" && (scorerModelDeclared || scorerCallsModel(code))
            ? modelIdentity(resolvedScorerModel)
            : null,
      }),
    [
      seedCandidate,
      objective,
      parsedCases,
      scorerKind,
      scorerUrl,
      scorerInstall,
      secretRevision,
      scorerModelDeclared,
      resolvedScorerModel,
    ],
  );
  // A passed check only vouches for the inputs it ran against; the identity
  // decides whether the evidence still applies. The ref lets an awaited check
  // see edits that landed while it ran.
  const currentEvaluatorIdentity = useMemo(
    () => describeEvaluator(metricCode),
    [describeEvaluator, metricCode],
  );
  const identityRef = useRef(currentEvaluatorIdentity);
  useEffect(() => {
    identityRef.current = currentEvaluatorIdentity;
  }, [currentEvaluatorIdentity]);
  const evaluatorStatus = evidenceStatus(
    evaluatorEvidence,
    runningIdentity,
    currentEvaluatorIdentity,
  );
  useEffect(() => {
    if (evaluatorStatus === "stale") setScorerValidation(null);
  }, [evaluatorStatus]);

  const buildScorer = useCallback(
    (code: string = metricCode): BlackboxScorer =>
      scorerKind === "python"
        ? {
            kind: "python",
            metric_code: code,
            timeout_seconds: SCORER_TIMEOUT_SECONDS,
            install_command: scorerInstall.trim() || null,
            model:
              (scorerModelDeclared || scorerCallsModel(code)) && resolvedScorerModel?.name.trim()
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
      scorerModelDeclared,
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

  // One evaluator check, recorded as evidence for the inputs it ran against.
  // Also the agent's metric validator: it passes the code it just wrote (the
  // state update hasn't landed yet), the editor's Run button passes nothing.
  const performDryRun = useCallback(
    async (
      overrideCode?: string,
    ): Promise<{ outcome: ValidationResult; evidence: ValidationEvidence }> => {
      const code = typeof overrideCode === "string" ? overrideCode : metricCode;
      const identity = describeEvaluator(code);
      const modelName =
        scorerKind === "python" && (scorerModelDeclared || scorerCallsModel(code))
          ? resolvedScorerModel?.name.trim() || null
          : null;
      setRunningIdentity(identity);
      setDryRun({ status: "running" });
      let outcome: ValidationResult;
      let evidence: ValidationEvidence;
      try {
        const result = await dryRunScorer({
          scorer: buildScorer(code),
          candidate: seedCandidate ?? objective,
          case: parsedCases?.rows[0] ?? null,
        });
        setDryRun({ status: "done", result });
        const creditsCharged = result.credits_charged ?? 0;
        if (creditsCharged > 0) setSetupSpent((spent) => spent + creditsCharged);
        const error = result.ok
          ? null
          : (result.error ?? msg("submit.blackbox.scorer.dry_run_failed"));
        outcome = { valid: result.ok, errors: error ? [error] : [], warnings: [] };
        evidence = {
          identity,
          ok: result.ok,
          error,
          checkedAt: Date.now(),
          modelName,
          creditsCharged,
        };
      } catch (err) {
        const error =
          err instanceof Error ? err.message : msg("submit.blackbox.scorer.dry_run_failed");
        setDryRun({ status: "done", result: { ok: false, error, side_info: {}, elapsed_ms: 0 } });
        outcome = { valid: false, errors: [error], warnings: [] };
        evidence = {
          identity,
          ok: false,
          error,
          checkedAt: Date.now(),
          modelName,
          creditsCharged: 0,
        };
      }
      setRunningIdentity((current) => (current === identity ? null : current));
      setEvaluatorEvidence(evidence);
      setScorerValidation(outcome);
      return { outcome, evidence };
    },
    [
      buildScorer,
      describeEvaluator,
      seedCandidate,
      objective,
      parsedCases,
      metricCode,
      scorerKind,
      scorerModelDeclared,
      resolvedScorerModel,
    ],
  );
  const runDryRun = useCallback(
    async (overrideCode?: string): Promise<ValidationResult | null> =>
      (await performDryRun(overrideCode)).outcome,
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

  // The interview is offered whatever the seed mode or hand edits: its brief
  // always yields a text starting point, so a parts or from-scratch seed
  // switches to Text when the draft lands (agentSetSeed below).
  // A clone is a complete prior submission — its seed is decided, so the
  // interview (which would redraft it on resolve) is never offered.
  const interviewPossible = codeAssistMode === "auto" && !cloned;
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
    runMetricValidation: runDryRun,
    seedEnabled: interview.resolved,
    interviewBrief: interview.confirmedBrief,
    blackbox: authoringContext,
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
  const autoEngineLabels = useMemo<string[]>(
    () =>
      (engineCatalog?.auto_engines ?? []).map(
        (id) => engineCatalog?.engines.find((e) => e.id === id)?.label ?? id,
      ),
    [engineCatalog],
  );
  // An engine that cannot run here stays selectable and configurable; only
  // Run is held back, with the backend's reason. Auto and Plateau need at
  // least one engine their recipe may invoke.
  const runDisabledReason = useMemo<string | null>(() => {
    if (!engineCatalog) return null;
    if (strategyMode === "single") {
      if (selectedEngine && !selectedEngine.available) {
        return selectedEngine.unavailable_reason?.trim()
          ? formatMsg("submit.blackbox.run_disabled.engine_reason", {
              engine: selectedEngine.label,
              reason: selectedEngine.unavailable_reason,
            })
          : formatMsg("submit.blackbox.run_disabled.engine", { engine: selectedEngine.label });
      }
      return null;
    }
    if ((engineCatalog.auto_engines ?? []).length === 0)
      return msg("submit.blackbox.run_disabled.no_engines");
    return null;
  }, [engineCatalog, strategyMode, selectedEngine]);
  const optimizationFamily = optimizationModelFamily(strategyMode, engine);

  const validateStep = (s: number, showToast = false): boolean => {
    const fail = (key: MessageKey, fieldId?: string) => {
      if (showToast) {
        toast.error(msg(key));
        if (fieldId) focusField(fieldId);
      }
      return false;
    };
    switch (s) {
      case WIZARD_STAGE.goal: {
        // In auto mode the agent drafts the text seed from the objective, so
        // the objective is the required input and the seed may stay blank.
        const agentDrafts = codeAssistMode === "auto" && seedMode === "text";
        if ((seedMode === "none" || agentDrafts) && !objective.trim())
          return fail("submit.blackbox.validation.objective_required", "bb-objective");
        if (seedMode !== "none" && !agentDrafts && seedCandidate == null)
          return fail("submit.blackbox.validation.seed_required", "bb-seed");
        return true;
      }
      case WIZARD_STAGE.evaluation: {
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
        if (scorerKind === "python" && scorerModelDeclared && !scorerCodeCallsModel)
          return fail("submit.blackbox.validation.scorer_llm_unused", "bb-scorer-uses-model");
        if (scorerKind === "remote" && !/^https?:\/\/\S+$/.test(scorerUrl.trim()))
          return fail("submit.blackbox.validation.scorer_url_required", "bb-scorer-url");
        if (parsedCases && Math.abs(split.train + split.val + split.test - 1) > 0.001)
          return fail("submit.blackbox.validation.split_sum", "bb-split");
        return true;
      }
      case WIZARD_STAGE.optimization: {
        // Availability is not a validation failure: an unavailable engine is a
        // configuration state that holds Run back with its reason.
        if (strategyMode === "single") {
          if (!engine || (engineCatalog && !selectedEngine))
            return fail("submit.blackbox.validation.engine_required", "bb-engines");
          if (seedMode === "parts" && selectedEngine && !selectedEngine.supports_parts)
            return fail("submit.blackbox.validation.engine_parts", "bb-engines");
        }
        if (!reflectionModel.name.trim())
          return fail(
            "submit.blackbox.validation.reflection_model_required",
            "bb-optimization-model",
          );
        if (maxScorerRuns < 1)
          return fail("submit.blackbox.validation.budget_required", "bb-max-runs");
        return true;
      }
      default:
        return true;
    }
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
    setDirection(idx > step ? 1 : -1);
    setStep(idx);
    setFurthestReachedStep((prev) => Math.max(prev, idx));
  };
  const goPrev = () => {
    if (step > 0) goTo(step - 1);
  };
  const budgetLedger = useMemo(
    () => ({ total: maxCostCredits, setupSpent, runSpent: 0, reserved: 0 }),
    [maxCostCredits, setupSpent],
  );
  const availableCredits = availableBudget(budgetLedger);

  // Continue runs the evaluator check unless current evidence already passed.
  // One toast per attempt, and it always ends: success, a concise error, or
  // "setup changed" when the inputs moved under the check.
  const ensureEvaluatorChecked = async (): Promise<boolean> => {
    if (evaluatorStatus === "passed") return true;
    const attempt = ++validationAttemptRef.current;
    const t = beginValidationToast(
      toast,
      `wizard-validate-${attempt}`,
      msg("submit.validation.toast.running"),
    );
    const modelName = scorerUsesModel ? resolvedScorerModel?.name.trim() : "";
    t.phase(
      modelName
        ? formatMsg("submit.validation.toast.testing_evaluator", {
            model: `\u2066${modelName}\u2069`,
          })
        : msg("submit.validation.toast.testing_evaluator_plain"),
    );
    const { evidence } = await performDryRun();
    if (identityRef.current !== evidence.identity) {
      t.obsolete(msg("submit.validation.toast.obsolete"));
      return false;
    }
    if (evidence.ok) {
      const locale = getActiveIntlLocale();
      const spentLine =
        evidence.creditsCharged > 0 && maxCostCredits != null
          ? formatMsg("submit.validation.toast.setup_used", {
              amount: formatCredits(evidence.creditsCharged, locale),
              remaining: formatCredits(
                Math.max(0, maxCostCredits - setupSpent - evidence.creditsCharged),
                locale,
              ),
            })
          : "";
      t.succeed(
        spentLine
          ? `${msg("submit.validation.toast.passed")} · ${spentLine}`
          : msg("submit.validation.toast.passed"),
      );
      return true;
    }
    t.fail(evidence.error ?? msg("submit.blackbox.scorer.dry_run_failed"));
    if (step !== WIZARD_STAGE.evaluation) goTo(WIZARD_STAGE.evaluation);
    focusField(scorerKind === "python" ? "bb-scorer-code" : "bb-scorer-url");
    return false;
  };
  // Leaving Evaluation checks the evaluator when its inputs are complete; a
  // scoring model still inherited from an unchosen optimization model defers
  // the check to leaving Optimization.
  const needsEvaluatorCheck = (from: number, to: number) =>
    from <= WIZARD_STAGE.optimization && to > WIZARD_STAGE.evaluation && !scoringModelPending;
  const advance = async (target: number) => {
    if (advancingRef.current) return;
    advancingRef.current = true;
    setAdvancing(true);
    try {
      for (let i = step; i < target; i++) {
        if (!validateStep(i, true)) {
          goTo(i);
          return;
        }
      }
      if (needsEvaluatorCheck(step, target) && !(await ensureEvaluatorChecked())) return;
      goTo(target);
    } finally {
      advancingRef.current = false;
      setAdvancing(false);
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

  const costBracket: CostBracket = useMemo(() => {
    const name = reflectionModel.name.trim();
    const model = name ? (catalog?.models.find((m) => m.value === name) ?? null) : null;
    // Every LM call in a black-box run goes through the reflection model, so it
    // prices both the "task" and the reflection share of the bracket.
    return projectCostBracket({
      autoLevel: "",
      maxFullEvals: "",
      maxMetricCalls: String(maxScorerRuns),
      datasetRows: Math.max(1, parsedCases?.rowCount ?? 0),
      taskModel: model,
      reflectionModel: model,
    });
  }, [reflectionModel.name, catalog, maxScorerRuns, parsedCases?.rowCount]);
  const suggestedCeiling = useMemo(() => defaultCeilingForBracket(costBracket), [costBracket]);
  const tokenSource = reflectionModel.token_source ?? "managed";

  // Suggested from the objective without a paid call; a typed or cloned name
  // always wins.
  const suggestedName = useMemo(() => suggestedRunName(objective), [objective]);

  const handleSubmit = async () => {
    if (advancingRef.current) return;
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
    try {
      if (!(await ensureEvaluatorChecked())) return;
    } finally {
      advancingRef.current = false;
      setAdvancing(false);
    }
    setSubmitting(true);
    setSubmitPhase("sending");
    try {
      const reflection = prepareModelConfig(reflectionModel);
      const estimate = chargeableBracket(costBracket, tokenSource);
      const payload: BlackboxRunRequest = {
        name: jobName.trim() || suggestedName || undefined,
        description: jobDescription.trim() || undefined,
        username,
        objective: objective.trim() || undefined,
        background: background.trim() || undefined,
        recipe,
        seed_candidate: seedCandidate ?? undefined,
        scorer: buildScorer(),
        cases: parsedCases?.rows,
        split_fractions: split,
        shuffle,
        seed,
        budget: {
          max_scorer_runs: maxScorerRuns,
          max_iterations: maxIterations === "" ? undefined : maxIterations,
          stop_at_score: parseOptionalNumber(stopAtScore),
        },
        strategy:
          strategyMode === "single"
            ? { mode: "single", engine }
            : strategyMode === "plateau"
              ? { mode: "plateau", patience }
              : { mode: "auto" },
        target: buildTarget(),
        reflection_model_config: reflection,
        token_source: tokenSource,
        is_private: isPrivate,
        max_cost_credits: maxCostCredits ?? undefined,
        estimated_credits_low: estimate.lowCredits,
        estimated_credits_high: estimate.highCredits,
      };
      const result = await submitBlackboxRun(payload);
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
      scorerModel: safeScorerModel,
      scorerModelDeclared,
      scorerModelMode,
      strategyMode,
      engine,
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
      // Leaving mid-setup keeps the draft: write whatever the debounce still holds.
      if (!submittedRef.current) draftsRef.current.flush();
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
    setJobName,
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
    scorerModel,
    setScorerModel,
    scorerModelDeclared,
    setScorerModelDeclared,
    scorerCodeCallsModel,
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
    strategyMode,
    setStrategyMode,
    engine,
    setEngine,
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
    reflectionModel,
    setReflectionModel,
    editingModel,
    setEditingModel,
    costBracket,
    suggestedCeiling,
    tokenSource,
    maxCostCredits,
    setMaxCostCredits,
    setupSpent,
    availableCredits,
    suggestedName,
  };
}

export type BlackboxWizardContext = ReturnType<typeof useBlackboxWizard>;
