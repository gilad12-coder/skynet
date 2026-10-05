"use client";

import { scorerCallsModel } from "../lib/scorer-dependencies";

import { resolveScorerDependencies } from "@/shared/lib/api";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { toast } from "react-toastify";

import type {
  BlackboxCandidate,
  BlackboxEngineCatalogResponse,
  BlackboxEngineId,
  BlackboxProposer,
  BlackboxRunRequest,
  BlackboxScorer,
  BlackboxTarget,
  ScorerDependencyLock,
  ModelConfig,
  ScorerDryRunResponse,
  ValidateCodeResponse,
} from "@/shared/types/api";
import {
  getBlackboxEngines,
  getDatasetRows,
  getStagedDataset,
  getJob,
  getOptimizationPayload,
  isInsufficientFundsError,
  isStorageQuotaError,
  stageDatasetForAgent,
  submitBlackboxRun,
  type BlackboxAuthoringContext,
  type DatasetSummary,
} from "@/shared/lib/api";
import { useWizardStateOptional } from "@/features/agent-panel";
import { registerTutorialHook } from "@/features/tutorial";
import { readPref } from "@/features/settings";
import { useCodeAgent } from "@/shared/hooks/use-code-agent";
import { useCodeInterview } from "@/shared/hooks/use-code-interview";
import { BLACKBOX_HARNESSES, UNAVAILABLE_HARNESSES } from "@/shared/lib/blackbox-harness";
import { parseDatasetFile, type ParsedDataset } from "@/shared/lib/parse-dataset";
import { formatMsg, msg } from "@/shared/lib/messages";
import { getActiveIntlLocale } from "@/shared/lib/runtime-locale";
import { track, TelemetryEvent } from "@/shared/lib/telemetry";
import type { MessageKey } from "@/shared/lib/generated/ui-catalog";
import type { ValidationResult } from "@/shared/ui/code-editor";

import { emptyModelConfig } from "../constants";
import { LAST_WIZARD_STAGE, WIZARD_STAGE, stageAt, type WizardStageId } from "../lib/wizard-steps";
import { suggestedRunName } from "../lib/budget";
import { blackboxEstimatedScorerRuns } from "../lib/blackbox-estimate";
import { detectLanguage, looksLikeCode, type SeedLanguage } from "../lib/seed-format";
import { cloneBasics, cloneRows, cloneSourceRecipe } from "../lib/clone-payload";
import type { WizardIssue } from "../lib/wizard-issue";
import { toastWizardIssue } from "../lib/wizard-issue-toast";
import { blackboxIssueStage } from "../lib/blackbox-issue-stage";
import { preflightDestination } from "../lib/preflight-destination";
import { preflightMayAdvance, preflightPendingMessageKey } from "../lib/preflight-outcome";
import {
  DEFAULT_PROPOSER,
  engineSelectionIssue,
  submittedProposer,
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
import { formatBudgetUsd, usePricingTerms } from "@/features/billing";
import { namedSeedParts, seedPartsIssue } from "../lib/seed-parts";
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
import { fileNewRun } from "../lib/file-new-run";
import { useExecutionBudget } from "./use-execution-budget";
import { prepareModelConfig } from "./use-submit-wizard";
import { useModelCatalog, useRecentModelConfigs } from "./use-submit-wizard-data";

export type SeedMode = "text" | "parts" | "none";
// The wizard offers three kinds of starting point: text, a program, or a
// GitHub repository. Runs saved before the prompt kind folded into text still
// carry "prompt"; they land on text.
export type BlackboxRecipe = "code" | "anything" | "repo";

interface SeedGuess {
  code: boolean;
  language: SeedLanguage | null;
}
const NO_GUESS: SeedGuess = { code: false, language: null };

/** Maps a stored or linked recipe onto the kinds the wizard offers. */
export function wizardRecipe(value: string | null | undefined): BlackboxRecipe {
  return value === "code" || value === "repo" ? value : "anything";
}

/** One environment variable a repository scorer reads: typed here, or saved on the account. */
export interface RepoSecretRow {
  name: string;
  value: string;
  savedSecretId: string | null;
}

export const REPO_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
export const REPO_SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

// A repository run always lets the agent edit the whole repository.
const WHOLE_REPOSITORY = ["."];

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

// The backend looks for a `score` (or `metric`) entrypoint and needs feedback
// with every score: `{"score", "feedback", "scores": {name: {"score",
// "feedback"}}}` or a `(score, "feedback")` tuple (see blackbox/scorer.py).
// The engines read that feedback to decide what to change next, so every
// template returns it, and splits the score into named parts when it measures
// more than one thing.
const SCORER_TEMPLATE = `from skynet import llm, Image  # llm(prompt, input=None, images=None) asks the scorer model

TARGET_WORDS = 150


def score(candidate, case=None):
    """Score one candidate. \`case\` is one row of your cases, or None without cases.

    Return the overall score (higher is better), feedback that says what to
    change, and one named score with its own feedback per thing you measure.
    """
    text = candidate if isinstance(candidate, str) else "\\n".join(candidate.values())
    words = len(text.split())
    length = max(0.0, 1.0 - abs(words - TARGET_WORDS) / TARGET_WORDS)
    paragraphs = [p for p in text.split("\\n\\n") if p.strip()]
    structure = min(1.0, len(paragraphs) / 3)
    return {
        "score": (length + structure) / 2,
        "feedback": f"{words} words in {len(paragraphs)} paragraphs.",
        "scores": {
            "length": {
                "score": length,
                "feedback": f"{words} words; aim for about {TARGET_WORDS}.",
            },
            "structure": {
                "score": structure,
                "feedback": f"{len(paragraphs)} paragraphs; three or more read best.",
            },
        },
    }
`;

const RUN_CODE_SCORER_TEMPLATE = `import os
import subprocess
import sys
import tempfile


def score(candidate, case=None):
    """Run the candidate as a python program; the last number it prints is the score.

    The feedback carries what went wrong (or the output), so the next version
    can fix it.
    """
    TIMEOUT_SECONDS = 30
    source = candidate if isinstance(candidate, str) else "\\n".join(candidate.values())
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as handle:
        handle.write(source)
    try:
        run = subprocess.run([sys.executable, handle.name], capture_output=True, text=True, timeout=TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        return 0.0, f"The program timed out after {TIMEOUT_SECONDS}s."
    finally:
        os.unlink(handle.name)
    if run.returncode != 0:
        return 0.0, "The program crashed:\\n" + run.stderr.strip()[-2000:]
    numbers = [token for token in run.stdout.split() if _is_number(token)]
    if not numbers:
        return 0.0, "The program printed no number. Output:\\n" + run.stdout[-2000:]
    return float(numbers[-1]), "The program ran. Output:\\n" + run.stdout[-2000:]


def _is_number(token):
    try:
        float(token)
    except ValueError:
        return False
    return True
`;

// A repository version is a checkout on disk: the scorer gets its path and
// runs whatever proves it better, here the repository's own test suite.
const REPO_SCORER_TEMPLATE = `import re
import subprocess


def score(repo_path, case=None):
    """Score one checkout. \`repo_path\` is a checkout of one version.

    Returns the share of tests that pass (higher is better) and the failing
    output as feedback, so the next version knows what to fix.
    """
    TIMEOUT_SECONDS = 600
    try:
        run = subprocess.run(
            ["python3", "-m", "pytest", "-q"],
            cwd=repo_path,
            capture_output=True,
            text=True,
            timeout=TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        return 0.0, f"The tests timed out after {TIMEOUT_SECONDS}s."
    passed = sum(int(n) for n in re.findall(r"(\\d+) passed", run.stdout))
    failed = sum(int(n) for n in re.findall(r"(\\d+) (?:failed|error)", run.stdout))
    total = passed + failed
    if total == 0:
        return 0.0, "No tests ran. Output:\\n" + (run.stdout + run.stderr)[-2000:]
    return passed / total, f"{passed} of {total} tests pass.\\n" + run.stdout[-2000:]
`;

// A program's natural yardstick is running it, so the code recipe opens on
// the run-program scorer instead of the generic word-count template.
function scorerTemplateFor(recipe: BlackboxRecipe): string {
  if (recipe === "repo") return REPO_SCORER_TEMPLATE;
  return recipe === "code" ? RUN_CODE_SCORER_TEMPLATE : SCORER_TEMPLATE;
}

// Not a wizard field: 300s covers every scorer shape the agent writes, and the
// backend caps the value at 600.
const SCORER_TIMEOUT_SECONDS = 300;
const DEFAULT_MAX_SCORER_RUNS = 100;

function parseOptionalNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function useBlackboxWizard(
  initialRecipe: BlackboxRecipe,
  folderId: string | null = null,
  touring = false,
) {
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
  const [economyMode, setEconomyMode] = useState(false);

  // Execution intent comes from the entry point or a clone, never from
  // syntax detection: code-shaped text may be a config or a prompt example.
  const [recipe, setRecipeState] = useState<BlackboxRecipe>(initialRecipe);
  const isRepo = recipe === "repo";
  const [repoName, setRepoName] = useState("");
  const [repoBranch, setRepoBranch] = useState("");
  const [repoSecrets, setRepoSecrets] = useState<RepoSecretRow[]>([]);

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
  const [parsedCases, setParsedCases] = useState<ParsedDataset | null>(null);
  const [casesName, setCasesName] = useState("");
  const [seed, setSeed] = useState<number | undefined>(undefined);
  const [libraryOpen, setLibraryOpen] = useState(false);

  const [scorerKind, setScorerKind] = useState<"python" | "remote">("python");
  const [metricCode, setMetricCode] = useState(scorerTemplateFor(initialRecipe));
  // The guided tour drives this wizard from plain-JS steps through the typed
  // tutorial bridge. Its demo setup counts as hand-written, so the writing
  // assistant never starts a paid pass over it.
  useEffect(() => {
    const unregister = [
      registerTutorialHook("setWizardStep", setStep),
      registerTutorialHook("setCodeAssistMode", setCodeAssistMode),
      registerTutorialHook("setBlackboxDemo", (demo) => {
        setSeedText(demo.seedText);
        setSeedManuallyEdited(true);
        setObjective(demo.objective);
        setMetricCode(demo.metricCode);
        setScorerManuallyEdited(true);
      }),
    ];
    return () => unregister.forEach((fn) => fn());
  }, []);
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

  const [strategyMode, setStrategyMode] = useState<"auto" | "single">("auto");
  const [engine, setEngine] = useState<BlackboxEngineId | null>(null);
  const proposerRuntime = "vercel" as const;
  const [proposer, setProposer] = useState<BlackboxProposer>(DEFAULT_PROPOSER);
  const updateProposer = useCallback(
    (patch: Partial<BlackboxProposer>) => setProposer((prev) => ({ ...prev, ...patch })),
    [],
  );
  const [engineCatalogResult, setEngineCatalogResult] = useState<{
    data: BlackboxEngineCatalogResponse | null;
  } | null>(null);
  const engineCatalog = engineCatalogResult?.data ?? null;
  const engineCatalogFailed = engineCatalogResult !== null && engineCatalog === null;
  const [maxScorerRuns, setMaxScorerRuns] = useState(DEFAULT_MAX_SCORER_RUNS);
  const [maxIterations, setMaxIterations] = useState<number | "">("");
  const [stopAtScore, setStopAtScore] = useState("");
  const [reflectionModel, setReflectionModel] = useState<ModelConfig>(emptyModelConfig());
  const nativeProposer = usesNativeProposer(strategyMode, engine, isRepo);
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
    maxCostCents,
    setMaxCostCents,
    budgetUncapped,
    setBudgetUncapped,
    session: budgetSession,
    setupSpent,
    availableCents,
  } = useExecutionBudget();

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
  // Staged id the current cases already correspond to, and the id being
  // fetched: together they stop the staging effect below from re-staging (or
  // clearing) rows the agent staged itself.
  const casesStagedIdRef = useRef<string | null>(null);
  const hydratingStagedIdRef = useRef<string | null>(null);
  const lastStagedCasesRef = useRef<ParsedDataset | null>(null);
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
      } else if (key === "seed" && typeof shared.seed === "number") {
        setSeed(shared.seed);
      } else if (key === "blackbox_objective" && typeof shared.blackbox_objective === "string") {
        setObjective(shared.blackbox_objective);
      } else if (key === "blackbox_seed" && typeof shared.blackbox_seed === "string") {
        // An agent-written seed is decided: the code agent must not replace it.
        setSeedMode("text");
        setSeedText(shared.blackbox_seed);
        setSeedManuallyEdited(true);
      } else if (
        key === "blackbox_scorer_code" &&
        typeof shared.blackbox_scorer_code === "string"
      ) {
        setScorerKind("python");
        setMetricCode(shared.blackbox_scorer_code);
        setScorerManuallyEdited(true);
      } else if (
        key === "staged_dataset_id" &&
        typeof shared.staged_dataset_id === "string" &&
        shared.staged_dataset_id !== casesStagedIdRef.current
      ) {
        const stagedId = shared.staged_dataset_id;
        hydratingStagedIdRef.current = stagedId;
        getStagedDataset(stagedId)
          .then((res) => {
            if (!mountedRef.current || hydratingStagedIdRef.current !== stagedId) return;
            if (!res || res.rows.length === 0) return;
            const hydrated: ParsedDataset = {
              columns: res.columns.length > 0 ? res.columns : Object.keys(res.rows[0] ?? {}),
              rows: res.rows,
              rowCount: res.row_count,
            };
            casesStagedIdRef.current = stagedId;
            lastStagedCasesRef.current = hydrated;
            setParsedCases(hydrated);
            setCasesName((prev) => prev || "dataset.json");
          })
          .catch(() => {
            /* best-effort: a failed fetch leaves the wizard's own cases intact */
          })
          .finally(() => {
            if (hydratingStagedIdRef.current === stagedId) hydratingStagedIdRef.current = null;
          });
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
    if (s.seed !== seed) wizardCtx.setField("seed", seed, "user");
    // The agent reads which workflow is on screen from job_type, and the task
    // itself from the blackbox_* fields; an empty or non-shareable value (a
    // multi-part seed, a remote scorer) is dropped rather than sent blank.
    if (s.job_type !== "blackbox") wizardCtx.setField("job_type", "blackbox", "user");
    const sharedTask = {
      blackbox_objective: objective.trim() ? objective : undefined,
      blackbox_seed: seedMode === "text" && seedText.trim() ? seedText : undefined,
      blackbox_scorer_code: scorerKind === "python" && metricCode.trim() ? metricCode : undefined,
    } as const;
    for (const key of Object.keys(sharedTask) as Array<keyof typeof sharedTask>) {
      const value = sharedTask[key];
      if (s[key] === value) continue;
      if (value === undefined) wizardCtx.clearField(key);
      else wizardCtx.setField(key, value, "user");
    }
  }, [
    wizardCtx,
    jobName,
    jobDescription,
    isPrivate,
    seed,
    objective,
    seedMode,
    seedText,
    scorerKind,
    metricCode,
  ]);
  // Stage the cases so the agent can submit them by id. With no cases the
  // field is cleared: the shared state outlives the program wizard, and a
  // dataset id left behind by it must never ride along on a black-box run.
  useEffect(() => {
    const ctx = wizardCtxRef.current;
    if (!ctx) return;
    if (!parsedCases || parsedCases.rowCount === 0) {
      if (ctx.state.staged_dataset_id !== undefined && !hydratingStagedIdRef.current) {
        ctx.clearField("staged_dataset_id");
      }
      lastStagedCasesRef.current = null;
      casesStagedIdRef.current = null;
      return;
    }
    if (lastStagedCasesRef.current === parsedCases) return;
    lastStagedCasesRef.current = parsedCases;
    stageDatasetForAgent({
      dataset: parsedCases.rows,
      dataset_filename: casesName || "dataset.json",
    })
      .then((res) => {
        if (!mountedRef.current || lastStagedCasesRef.current !== parsedCases) return;
        casesStagedIdRef.current = res.staged_dataset_id;
        wizardCtxRef.current?.setField("staged_dataset_id", res.staged_dataset_id, "user");
      })
      .catch(() => {
        if (lastStagedCasesRef.current === parsedCases) lastStagedCasesRef.current = null;
      });
  }, [parsedCases, casesName]);
  // A clone's stage is applied one render after its fields, so the
  // prerequisite walk (below validateStep) checks the cloned state rather
  // than the empty initial one.
  const [pendingRestore, setPendingRestore] = useState<{
    stage: WizardStageId;
    furthest: WizardStageId;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEngineCatalogResult(null);
    getBlackboxEngines(isRepo ? "repo" : "text")
      .then((res) => {
        if (!cancelled) setEngineCatalogResult({ data: res });
      })
      .catch(() => {
        if (!cancelled) setEngineCatalogResult({ data: null });
      });
    return () => {
      cancelled = true;
    };
  }, [isRepo]);

  // A repository is searched by one hand-picked engine, never Auto, so the
  // strategy settles on AutoResearch unless another engine was chosen.
  useEffect(() => {
    if (!isRepo) return;
    setStrategyMode("single");
    setEngine((current) => current ?? "autoresearch");
    setScorerKind("python");
  }, [isRepo, strategyMode, engine]);

  /** Switch between optimizing text and a repository, keeping a hand-written scorer. */
  const setRecipe = useCallback(
    (next: BlackboxRecipe) => {
      if (next === recipe) return;
      setRecipeState(next);
      if (!scorerManuallyEdited) setMetricCode(scorerTemplateFor(next));
      if (recipe === "repo") setStrategyMode("auto");
    },
    [recipe, scorerManuallyEdited],
  );

  // A `?clone=` link hydrates the wizard from the source run's stored payload
  // (server-scrubbed: no model api_key, no remote-scorer secret). The clone
  // link only preselects the picker; the recipe kind, seed, cases, scorer and
  // optimizer all come from the payload.
  const cloneRan = useRef(false);
  const [cloned, setCloned] = useState(false);
  const [issue, setIssue] = useState<WizardIssue | null>(null);
  useEffect(() => {
    const cloneId = searchParams.get("clone");
    if (!cloneId || cloneRan.current) return;
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
          setEconomyMode(source.economy_mode === true);
          if (source.recipe) setRecipeState(wizardRecipe(source.recipe));
          const repo = source.target?.kind === "repo" ? source.target.repo : null;
          if (repo) {
            setRecipeState("repo");
            setRepoName(repo.repository);
            setRepoBranch(repo.branch ?? "");
            // Typed values are scrubbed from the stored run; saved ones keep their reference.
            setRepoSecrets(
              (repo.secrets ?? []).map((row) => ({
                name: row.name,
                value: "",
                savedSecretId: row.saved_secret_id ?? null,
              })),
            );
          }
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
        }

        const rows = cloneRows(stored);
        if (rows) {
          setParsedCases(rows);
          setCasesName(String(basics.name || cloneId));
        }
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
            // Jobs run with the retired plateau relay clone as Auto.
            setStrategyMode(strategy.mode === "single" ? "single" : "auto");
            setEngine(strategy.engine ?? null);
          }
          // A custom proposer command has no picker, and an unavailable harness
          // cannot be submitted, so such clones keep the default.
          if (
            source.proposer &&
            BLACKBOX_HARNESSES.includes(source.proposer.harness) &&
            !UNAVAILABLE_HARNESSES.includes(source.proposer.harness)
          )
            setProposer({ ...DEFAULT_PROPOSER, ...source.proposer });
          const budget = source.budget;
          if (budget) {
            if (budget.max_scorer_runs != null) setMaxScorerRuns(budget.max_scorer_runs);
            setMaxIterations(budget.max_iterations ?? "");
            setStopAtScore(budget.stop_at_score == null ? "" : String(budget.stop_at_score));
          }
          if (source.max_cost_cents != null) setMaxCostCents(source.max_cost_cents);
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
      })
      .catch(() => {
        toast.error(msg("submit.clone.failed"));
      });
  }, [searchParams]);

  // What the seed reads as, latched until the seed is cleared so the editor
  // never swaps out from under the caret while a snippet is typed or trimmed.
  // This controls editor presentation only, not the recipe or evaluator.
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
  }, [seedSample]);
  const seedIsCode = recipe === "code" || seedGuess.code;

  const seedCandidate = useMemo<BlackboxCandidate | null>(() => {
    if (isRepo) return null;
    if (seedMode === "none") return null;
    if (seedMode === "text") return seedText.trim() ? seedText : null;
    const parts = namedSeedParts(seedParts).filter((p) => p.key.trim() && p.value.trim());
    return parts.length ? Object.fromEntries(parts.map((p) => [p.key.trim(), p.value])) : null;
  }, [isRepo, seedMode, seedText, seedParts]);

  // The seed candidate runs inside the scorer box, so its imports belong in the
  // dependency lock — but the signed lock binds only to the scorer source, so
  // its seed provenance is tracked here to re-resolve when the seed changes.
  const seedCandidateRef = useRef(seedCandidate);
  useEffect(() => {
    seedCandidateRef.current = seedCandidate;
  }, [seedCandidate]);
  const resolvedSeedKeyRef = useRef<string>(JSON.stringify(seedCandidate ?? null));
  useEffect(() => {
    resolvedSeedKeyRef.current = JSON.stringify(seedCandidateRef.current ?? null);
  }, [scorerDependencyLock]);

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

  const pricing = usePricingTerms();

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
      // The final run scores the starting version and the winner afresh,
      // outside the search budget, so the estimate counts it on top.
      maxMetricCalls: String(
        blackboxEstimatedScorerRuns(
          maxScorerRuns,
          parsedCases?.rowCount ?? 0,
          isRepo || seedCandidate != null,
        ),
      ),
      datasetRows: parsedCases?.rowCount ?? 0,
      modelRoles,
      runtime: runtimeCostProjection(selectedRuntime?.cost, scorerKind === "python" ? 4 : 3),
      pricing,
      // Coding-agent proposers stream their calls, which never batch, so their
      // estimate keeps full price.
      economyMode: economyMode && !nativeProposer,
    });
  }, [
    effectiveReflectionModel,
    scorerUsesModel,
    resolvedScorerModel,
    catalog,
    engineCatalog,
    maxScorerRuns,
    scorerKind,
    parsedCases?.rowCount,
    isRepo,
    seedCandidate,
    pricing,
    economyMode,
    nativeProposer,
  ]);
  const tokenSource = aggregateTokenSource([
    effectiveReflectionModel,
    ...(scorerUsesModel && resolvedScorerModel ? [resolvedScorerModel] : []),
  ]);
  const suggestedCeiling = useMemo(
    () => defaultCeilingForBracket(chargeableBracket(costBracket, tokenSource)),
    [costBracket, tokenSource],
  );

  const repoTarget = (): BlackboxTarget => ({
    kind: "repo",
    repo: {
      provider: "github",
      repository: repoName.trim(),
      branch: repoBranch.trim() || null,
      editable_paths: WHOLE_REPOSITORY,
      secrets: repoSecrets
        .filter((row) => row.name.trim())
        .map((row) =>
          row.savedSecretId
            ? { name: row.name.trim(), saved_secret_id: row.savedSecretId }
            : { name: row.name.trim(), value: row.value },
        ),
    },
  });

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
      seed,
      budget: {
        max_scorer_runs: maxScorerRuns,
        max_iterations: iterationLimitSupported && maxIterations !== "" ? maxIterations : undefined,
        stop_at_score: parseOptionalNumber(stopAtScore),
      },
      strategy: strategyMode === "single" ? { mode: "single", engine } : { mode: "auto" },
      proposer_runtime: proposerRuntime,
      proposer: nativeProposer ? submittedProposer(proposer, strategyMode, engine) : undefined,
      target: isRepo ? repoTarget() : { kind: "text" },
      reflection_model_config: reflection,
      token_source: tokenSource,
      is_private: isPrivate,
      ...(economyMode && { economy_mode: true }),
      max_cost_cents: budgetUncapped ? undefined : (maxCostCents ?? undefined),
      estimated_cents_low: estimate.lowCents,
      estimated_cents_high: estimate.highCents,
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
      const code = overrideCode ?? metricCode;
      if (scorerKind === "python" && scorerCallsModel(code) && !resolvedScorerModel?.name.trim()) {
        const error = msg("submit.blackbox.validation.scorer_model_required");
        const outcome = { valid: false, errors: [error], warnings: [] };
        setScorerValidation(outcome);
        throw new Error(error);
      }
      const attempt = ++dryRunAttemptRef.current;
      const navigation = navigationRevisionRef.current;
      const requestPayload = buildSubmissionPayload(overrideCode);
      const initialIdentity = preflight.identity;
      let completed: WizardPreflightResponse | null | undefined;
      preflight.progress.start(scope);
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
          const seedKey = JSON.stringify(requestPayload.seed_candidate ?? null);
          if (
            !lock ||
            lock.code_sha256 !== digest ||
            JSON.stringify(lock.requirements) !== JSON.stringify(requirements) ||
            resolvedSeedKeyRef.current !== seedKey
          ) {
            const currentBudget = await budgetSession.ensure();
            preflight.progress.phase("dependencies");
            const resolved = await resolveScorerDependencies({
              code,
              requirements,
              seed_candidate: requestPayload.seed_candidate,
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
          centsCharged: response.scorer_result?.cents_charged,
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
        preflight.progress.finish(response.status, undefined, response);
        return { response, evidence, outcome };
      } catch (error) {
        // A cancelled check leaves no trace; a failed one stays on screen.
        if (error instanceof Error && error.name === "AbortError") preflight.progress.clear();
        else
          preflight.progress.finish(
            "failed",
            error instanceof Error ? error.message : msg("submit.preflight.failed"),
          );
        throw error;
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
      metricCode,
      scorerKind,
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
    // A repository has no text seed to draft, so it reads as "anything"; the
    // agent gets the repository itself to read before it asks.
    () => ({
      recipe: recipe === "repo" ? "anything" : recipe,
      objective,
      background,
      target_kind: "text",
      scorer_has_model: scorerUsesModel && (resolvedScorerModel?.name.trim().length ?? 0) > 0,
      focus: stageAt(step) === "evaluation" ? "scorer" : "goal",
      ...(isRepo && repoName.trim()
        ? {
            repository: repoName.trim(),
            branch: repoBranch.trim(),
            editable_paths: WHOLE_REPOSITORY,
          }
        : {}),
    }),
    [
      recipe,
      objective,
      background,
      scorerUsesModel,
      resolvedScorerModel,
      step,
      isRepo,
      repoName,
      repoBranch,
    ],
  );

  // The guided tour drives the wizard with demo data, so no paid assistant starts.
  const interviewPossible =
    !isRepo &&
    !touring &&
    codeAssistMode === "auto" &&
    !cloned &&
    !seedManuallyEdited &&
    !scorerManuallyEdited;
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
    jobModel: reflectionModel.name,
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
  // The agent writes the brief from the conversation; what it sends is the
  // field's full new text, so it replaces what was there.
  const agentSetBrief = useCallback((fields: { objective?: string; background?: string }) => {
    if (fields.objective !== undefined) setObjective(fields.objective);
    if (fields.background !== undefined) setBackground(fields.background);
  }, []);
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
    // A repository has no text seed to draft, and its scorer is written by hand.
    seedEnabled: !isRepo && interview.resolved,
    interviewBrief: interview.confirmedBrief,
    blackbox: authoringContext,
    onBrief: agentSetBrief,
    // The guided tour's demo repository must not start the agent.
    kickoffEnabled: isRepo && !touring,
    model: interview.model,
    reasoningEffort: interview.reasoningEffort,
  });

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const cases = await parseDatasetFile(file);
      setParsedCases(cases);
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
  const runDisabledReason = useMemo<string | null>(() => {
    if (engineCatalogFailed) return msg("submit.blackbox.engines.check_failed");
    const issue = engineSelectionIssue({
      catalog: engineCatalog,
      mode: strategyMode,
      engine,
      hasParts: seedMode === "parts",
      repo: isRepo,
    });
    return issue ? msg(issue.key, issue.params) : null;
  }, [engineCatalog, engineCatalogFailed, strategyMode, engine, seedMode, isRepo]);
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
        if (isRepo) {
          if (!REPO_NAME_PATTERN.test(repoName.trim()))
            return fail("submit.blackbox.repo.validation.repository", "bb-repo-name");
          const named = repoSecrets.filter(
            (row) => row.name.trim() || row.value || row.savedSecretId,
          );
          if (named.some((row) => !REPO_SECRET_NAME_PATTERN.test(row.name.trim())))
            return fail("submit.blackbox.repo.validation.secret_name", "bb-repo-secrets");
          if (new Set(named.map((row) => row.name.trim())).size !== named.length)
            return fail("submit.blackbox.repo.validation.secret_duplicate", "bb-repo-secrets");
          if (named.some((row) => !row.savedSecretId && !row.value))
            return fail("submit.blackbox.repo.validation.secret_value", "bb-repo-secrets");
          return null;
        }
        const partsIssue = seedMode === "parts" ? seedPartsIssue(namedSeedParts(seedParts)) : null;
        if (partsIssue) return fail(`submit.parts.${partsIssue}`, "bb-seed");
        // The scorer alone drives the climb, so neither an objective nor a
        // starting point is required: a blank run starts from empty text.
        return null;
      }
      case WIZARD_STAGE.evaluation: {
        if (!budgetUncapped && maxCostCents == null)
          return fail("budget.invalid", "totalBudgetInput");
        if (scorerKind === "python" && !metricCode.trim())
          return fail("submit.blackbox.validation.scorer_code_required", "bb-scorer-code");
        if (scorerUsesModel && !resolvedScorerModel?.name.trim())
          return fail("submit.blackbox.validation.scorer_model_required", "bb-scoring-model");
        if (scorerKind === "remote" && !/^https?:\/\/\S+$/.test(scorerUrl.trim()))
          return fail("submit.blackbox.validation.scorer_url_required", "bb-scorer-url");
        return null;
      }
      case WIZARD_STAGE.optimization: {
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
        if (strategyMode === "auto" && maxScorerRuns < 5)
          return fail("submit.blackbox.validation.auto_budget", "bb-max-runs");
        if (maxScorerRuns < 1)
          return fail("submit.blackbox.validation.budget_required", "bb-max-runs");
        return null;
      }
      default:
        return null;
    }
  };

  /** Toasts a problem and opens the field that fixes it. */
  const reportIssue = (found: WizardIssue) => {
    setIssue({ ...found });
    toastWizardIssue(found);
  };
  /** Validates a stage; `report` surfaces its first problem. */
  const validateStep = (s: number, report = false): boolean => {
    const found = stageIssue(s);
    if (found && report) reportIssue(found);
    return found == null;
  };

  // Walk the cloned stage's prerequisites against the cloned state: a stage
  // whose earlier stages no longer validate opens on the first failing one
  // instead.
  useEffect(() => {
    if (!pendingRestore) return;
    setPendingRestore(null);
    const target = WIZARD_STAGE[pendingRestore.stage];
    let reachable = 0;
    while (reachable < target && validateStep(reachable)) reachable += 1;
    setStep(reachable);
    setFurthestReachedStep(Math.max(reachable, WIZARD_STAGE[pendingRestore.furthest]));
  }, [pendingRestore, validateStep]);

  // A passed execution check held on the Optimization stage settles as the
  // wizard leaves it; one run on the way to another stage, and a scorer test
  // run from the evaluator step, linger and clear themselves.
  const settleHeldCheck = () => {
    const progress = preflight.progress.state;
    if (progress?.status !== "succeeded" || progress.scope !== "execution") return;
    if (step === WIZARD_STAGE.optimization) preflight.progress.clear();
  };
  const moveTo = (idx: number) => {
    navigationRevisionRef.current += 1;
    dryRunAttemptRef.current += 1;
    setDryRun((current) => (current.status === "running" ? { status: "idle" } : current));
    preflight.cancel();
    settleHeldCheck();
    validationToastRef.current?.dismiss();
    setDirection(idx > step ? 1 : -1);
    setStep(idx);
    setFurthestReachedStep((prev) => Math.max(prev, idx));
  };
  // A check failure holds its stage until the checked setup changes; a
  // validation problem holds it until the stage validates.
  const currentIssue = (): WizardIssue | null => {
    if (
      issue?.identity &&
      blackboxIssueStage(issue) === stageAt(step) &&
      issue.identity === preflight.identity
    )
      return issue;
    return stageIssue(step);
  };
  /**
   * Whether the wizard may leave its stage for `target`: a problem is reported
   * and holds it, unless the field that fixes it is on the target stage.
   */
  const leaveStage = (target: number): boolean => {
    const found = currentIssue();
    if (!found) return true;
    reportIssue(found);
    return WIZARD_STAGE[blackboxIssueStage(found)] === target;
  };
  const goTo = (idx: number) => {
    if (idx !== step && !leaveStage(idx)) return;
    moveTo(idx);
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
      preflight.feedback(scope),
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
      if (response.status === "succeeded" && preflightMayAdvance(response, scope)) {
        const locale = getActiveIntlLocale();
        t.succeed(
          `${msg("submit.preflight.succeeded")} · ${msg("submit.budget.setup_spent")}: ${formatBudgetUsd(response.budget.setup_spent_cents, locale)} · ${msg("submit.budget.available")}: ${formatBudgetUsd(response.budget.available_cents, locale)}`,
        );
        return response;
      }
      if (response.status === "pending") {
        t.pending(msg(preflightPendingMessageKey(response)));
        return null;
      }
      const failure = response.checks.find((check) => check.status === "failed");
      t.fail(failure?.message ?? msg("submit.preflight.failed"));
      const destination = preflightDestination("anything", failure?.field ?? failure?.key, scope);
      moveTo(WIZARD_STAGE[destination.stage]);
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
          moveTo(WIZARD_STAGE.evaluation);
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
    if (advancingRef.current || !leaveStage(target)) return;
    advancingRef.current = true;
    setAdvancing(true);
    setIssue(null);
    try {
      settleHeldCheck();
      for (let i = 0; i < target; i++) {
        if (!validateStep(i, true)) {
          moveTo(i);
          return;
        }
      }
      // The one mandatory check runs once the configuration is complete, on the
      // way out of Optimization: evaluator, sandbox and every model in one pass.
      // Run from its own stage it is a page of its own: the wizard holds on the
      // result, and the next Continue moves on. A pass reused from an earlier
      // run moves on at once.
      if (target > WIZARD_STAGE.optimization) {
        const reused = Boolean(preflight.reusable("execution"));
        if (!(await ensureEvaluatorChecked("execution"))) return;
        if (!reused && step === WIZARD_STAGE.optimization) return;
      }
      moveTo(target);
    } finally {
      advancingRef.current = false;
      if (mountedRef.current) setAdvancing(false);
    }
  };
  // A check the user walked away from is picked up where it stands: the frame
  // already shows it, and its outcome holds or moves the wizard on the way
  // Next would have. One that finished while they were gone is its own page.
  const resumedRef = useRef(false);
  useEffect(() => {
    if (resumedRef.current || pendingRestore) return;
    resumedRef.current = true;
    const progress = preflight.progress.state;
    if (!progress || progress.identity !== preflight.identity) return;
    // Only the execution pass moves the wizard; a scorer test settles where it ran.
    if (progress.scope !== "execution") return;
    // A pass is already its own page; a run still going is joined.
    if (progress.status !== "running") return;
    void advance(WIZARD_STAGE.review);
  });

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
        moveTo(i);
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
        target: isRepo ? "repo" : "text",
        scorer: scorerKind,
        has_cases: parsedCases != null,
      });
      submittedRef.current = true;
      await fileNewRun(result.optimization_id, folderId);
      const jobUrl = `/optimizations/${result.optimization_id}`;
      setSubmitPhase("splash");
      window.dispatchEvent(new Event("sidebar:collapse"));
      setTimeout(() => {
        setSubmitPhase("done");
        router.push(jobUrl);
      }, 1500);
    } catch (err) {
      // The storage-budget 409 and the balance-gate 402 each open their own shared
      // modal centrally; suppress the redundant toast so the modal is the single
      // surface for both.
      if (!isStorageQuotaError(err) && !isInsufficientFundsError(err)) {
        toast.error(err instanceof Error ? err.message : msg("submit.submit_failed"));
      }
      setSubmitPhase("idle");
      setSubmitting(false);
    }
  };

  useEffect(
    () => () => {
      // A submit leaves on purpose: reset the shared agent state.
      if (submittedRef.current) wizardCtxRef.current?.reset();
    },
    [],
  );

  return {
    recipe,
    setRecipe,
    isRepo,
    repoName,
    setRepoName,
    repoBranch,
    setRepoBranch,
    repoSecrets,
    setRepoSecrets,
    step,
    direction,
    maxReachableStep: furthestReachedStep,
    advancing,
    submitting,
    submitPhase,
    validateStep,
    leaveStage,
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
    economyMode,
    setEconomyMode,
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
    parsedCases,
    casesName,
    handleFileUpload,
    handlePickFromLibrary,
    clearCases,
    libraryOpen,
    setLibraryOpen,
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
    proposer,
    updateProposer,
    nativeProposer,
    iterationLimitSupported,
    engineCatalog,
    selectedEngine,
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
    maxCostCents,
    setMaxCostCents,
    budgetUncapped,
    setBudgetUncapped,
    budgetSession,
    setupSpent,
    availableCents,
    suggestedName,
  };
}

export type BlackboxWizardContext = ReturnType<typeof useBlackboxWizard>;
