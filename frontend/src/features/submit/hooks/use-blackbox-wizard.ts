"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
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
} from "@/shared/types/api";
import {
  dryRunScorer,
  getBlackboxEngines,
  getDatasetRows,
  isInsufficientCreditsError,
  isStorageQuotaError,
  submitBlackboxRun,
  type DatasetSummary,
} from "@/shared/lib/api";
import { parseDatasetFile, type ParsedDataset } from "@/shared/lib/parse-dataset";
import { msg } from "@/shared/lib/messages";
import { track, TelemetryEvent } from "@/shared/lib/telemetry";
import type { ValidationResult } from "@/shared/ui/code-editor";

import { BLACKBOX_STEPS, defaultSplit, emptyModelConfig } from "../constants";
import {
  chargeableBracket,
  defaultCeilingForBracket,
  projectCostBracket,
  type CostBracket,
} from "../lib/cost-bracket";
import { prepareModelConfig } from "./use-submit-wizard";
import { useModelCatalog, useRecentModelConfigs } from "./use-submit-wizard-data";

export type SeedMode = "text" | "parts" | "none";
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
export const SCORER_TEMPLATE = `def score(candidate, case=None):
    """Return a number — higher is better. \`case\` is one row of your cases (or None)."""
    text = candidate if isinstance(candidate, str) else "\\n".join(candidate.values())
    return float(len(text.split()))
`;

const DEFAULT_MAX_SCORER_RUNS = 100;

function parseOptionalNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function useBlackboxWizard() {
  const router = useRouter();
  const { data: session } = useSession();
  const username = session?.user?.name ?? "";
  const catalog = useModelCatalog();
  const { recentConfigs, saveToRecent, removeRecentConfig } = useRecentModelConfigs();

  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState(0);
  const [furthestReachedStep, setFurthestReachedStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitPhase, setSubmitPhase] = useState<"idle" | "sending" | "splash" | "done">("idle");

  const [jobName, setJobName] = useState("");
  const [jobDescription, setJobDescription] = useState("");
  const [isPrivate, setIsPrivate] = useState(true);

  const [seedMode, setSeedMode] = useState<SeedMode>("text");
  const [seedText, setSeedText] = useState("");
  const [seedParts, setSeedParts] = useState<SeedPart[]>([{ key: "", value: "" }]);
  const [objective, setObjective] = useState("");
  const [background, setBackground] = useState("");
  const [targetKind, setTargetKind] = useState<"text" | "agent">("text");
  const [harness, setHarness] = useState<BlackboxHarness>("pi");
  const [targetModel, setTargetModel] = useState("");
  const [targetTimeout, setTargetTimeout] = useState(600);
  const [targetConcurrency, setTargetConcurrency] = useState(2);
  const [setupCommand, setSetupCommand] = useState("");
  const [installCommand, setInstallCommand] = useState("");
  const [runCommand, setRunCommand] = useState("");

  const [parsedCases, setParsedCases] = useState<ParsedDataset | null>(null);
  const [casesName, setCasesName] = useState("");
  const [split, setSplit] = useState<SplitFractions>(defaultSplit);
  const [shuffle, setShuffle] = useState(true);
  const [libraryOpen, setLibraryOpen] = useState(false);

  const [scorerKind, setScorerKind] = useState<"python" | "remote">("python");
  const [metricCode, setMetricCode] = useState(SCORER_TEMPLATE);
  const [scorerUrl, setScorerUrl] = useState("");
  const [scorerSecret, setScorerSecret] = useState("");
  const [scorerTimeout, setScorerTimeout] = useState(60);
  const [dryRun, setDryRun] = useState<DryRunState>({ status: "idle" });

  const [strategyMode, setStrategyMode] = useState<"auto" | "single">("auto");
  const [engine, setEngine] = useState<BlackboxEngineId | null>(null);
  const [engineCatalog, setEngineCatalog] = useState<BlackboxEngineCatalogResponse | null>(null);
  const [maxScorerRuns, setMaxScorerRuns] = useState(DEFAULT_MAX_SCORER_RUNS);
  const [maxIterations, setMaxIterations] = useState<number | "">("");
  const [stopAtScore, setStopAtScore] = useState("");
  const [reflectionModel, setReflectionModel] = useState<ModelConfig>(emptyModelConfig());
  const [editingModel, setEditingModel] = useState<{
    config: ModelConfig;
    onSave: (c: ModelConfig) => void;
    label: string;
  } | null>(null);
  const [maxCostCredits, setMaxCostCredits] = useState<number | null>(null);

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

  // A passed dry run only vouches for the scorer it ran against.
  useEffect(() => {
    setDryRun({ status: "idle" });
  }, [scorerKind, metricCode, scorerUrl, scorerSecret, scorerTimeout]);

  const seedCandidate = useMemo<BlackboxCandidate | null>(() => {
    if (seedMode === "none") return null;
    if (seedMode === "text") return seedText.trim() ? seedText : null;
    const parts = seedParts.filter((p) => p.key.trim() && p.value.trim());
    return parts.length ? Object.fromEntries(parts.map((p) => [p.key.trim(), p.value])) : null;
  }, [seedMode, seedText, seedParts]);

  const buildScorer = useCallback(
    (): BlackboxScorer =>
      scorerKind === "python"
        ? { kind: "python", metric_code: metricCode, timeout_seconds: scorerTimeout }
        : {
            kind: "remote",
            url: scorerUrl.trim(),
            secret: scorerSecret.trim() || undefined,
            timeout_seconds: scorerTimeout,
          },
    [scorerKind, metricCode, scorerTimeout, scorerUrl, scorerSecret],
  );

  const buildTarget = (): BlackboxTarget =>
    targetKind === "text"
      ? { kind: "text" }
      : {
          kind: "agent",
          harness,
          model: targetModel.trim(),
          timeout_seconds: targetTimeout,
          concurrency: targetConcurrency,
          setup_command: setupCommand.trim() || undefined,
          install_command: installCommand.trim() || undefined,
          run_command: runCommand.trim() || undefined,
        };

  const runDryRun = useCallback(async (): Promise<ValidationResult | null> => {
    setDryRun({ status: "running" });
    try {
      const result = await dryRunScorer({
        scorer: buildScorer(),
        candidate: seedCandidate ?? objective,
        case: parsedCases?.rows[0] ?? null,
      });
      setDryRun({ status: "done", result });
      return {
        valid: result.ok,
        errors: result.ok ? [] : [result.error ?? msg("submit.blackbox.scorer.dry_run_failed")],
        warnings: [],
      };
    } catch (err) {
      const error =
        err instanceof Error ? err.message : msg("submit.blackbox.scorer.dry_run_failed");
      setDryRun({ status: "done", result: { ok: false, error, side_info: {}, elapsed_ms: 0 } });
      return { valid: false, errors: [error], warnings: [] };
    }
  }, [buildScorer, seedCandidate, objective, parsedCases]);

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

  const validateStep = (s: number, showToast = false): boolean => {
    const fail = (key: Parameters<typeof msg>[0]) => {
      if (showToast) toast.error(msg(key));
      return false;
    };
    switch (s) {
      case 1: {
        if (seedMode === "none" && !objective.trim())
          return fail("submit.blackbox.validation.objective_required");
        if (seedMode !== "none" && seedCandidate == null)
          return fail("submit.blackbox.validation.seed_required");
        if (targetKind === "agent") {
          if (!targetModel.trim()) return fail("submit.blackbox.validation.agent_model_required");
          if (harness === "custom" && !runCommand.trim())
            return fail("submit.blackbox.validation.run_command_required");
        }
        return true;
      }
      case 2: {
        if (targetKind === "agent" && !parsedCases?.rowCount)
          return fail("submit.blackbox.validation.cases_required");
        if (parsedCases && Math.abs(split.train + split.val + split.test - 1) > 0.001)
          return fail("submit.blackbox.validation.split_sum");
        return true;
      }
      case 3: {
        if (scorerKind === "python" && !metricCode.trim())
          return fail("submit.blackbox.validation.scorer_code_required");
        if (scorerKind === "remote" && !/^https?:\/\/\S+$/.test(scorerUrl.trim()))
          return fail("submit.blackbox.validation.scorer_url_required");
        if (dryRun.status !== "done" || !dryRun.result.ok)
          return fail("submit.blackbox.validation.dry_run_required");
        return true;
      }
      case 4: {
        if (strategyMode === "single") {
          if (!selectedEngine?.available) return fail("submit.blackbox.validation.engine_required");
          if (seedMode === "parts" && !selectedEngine.supports_parts)
            return fail("submit.blackbox.validation.engine_parts");
        }
        if (!reflectionModel.name.trim())
          return fail("submit.blackbox.validation.reflection_model_required");
        if (maxScorerRuns < 1) return fail("submit.blackbox.validation.budget_required");
        return true;
      }
      default:
        return true;
    }
  };

  const goTo = (idx: number) => {
    setDirection(idx > step ? 1 : -1);
    setStep(idx);
    setFurthestReachedStep((prev) => Math.max(prev, idx));
  };
  const goPrev = () => {
    if (step > 0) goTo(step - 1);
  };
  const handleNext = async () => {
    if (validateStep(step, true)) goTo(step + 1);
  };
  const handleTabClick = (idx: number) => {
    if (idx <= step) {
      goTo(idx);
      return;
    }
    for (let i = step; i < idx; i++) {
      if (!validateStep(i, true)) {
        goTo(i);
        return;
      }
    }
    goTo(idx);
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

  const handleSubmit = async () => {
    for (let i = 0; i < BLACKBOX_STEPS.length - 1; i++) {
      if (!validateStep(i, true)) {
        goTo(i);
        return;
      }
    }
    setSubmitting(true);
    setSubmitPhase("sending");
    try {
      const reflection = prepareModelConfig(reflectionModel);
      const estimate = chargeableBracket(costBracket, tokenSource);
      const payload: BlackboxRunRequest = {
        name: jobName.trim() || undefined,
        description: jobDescription.trim() || undefined,
        username,
        objective: objective.trim() || undefined,
        background: background.trim() || undefined,
        seed_candidate: seedCandidate ?? undefined,
        scorer: buildScorer(),
        cases: parsedCases?.rows,
        split_fractions: split,
        shuffle,
        budget: {
          max_scorer_runs: maxScorerRuns,
          max_iterations: maxIterations === "" ? undefined : maxIterations,
          stop_at_score: parseOptionalNumber(stopAtScore),
        },
        strategy: strategyMode === "single" ? { mode: "single", engine } : { mode: "auto" },
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

  return {
    step,
    direction,
    maxReachableStep: furthestReachedStep,
    advancing: false,
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
    seedMode,
    setSeedMode,
    seedText,
    setSeedText,
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
    setupCommand,
    setSetupCommand,
    installCommand,
    setInstallCommand,
    runCommand,
    setRunCommand,
    parsedCases,
    casesName,
    handleFileUpload,
    handlePickFromLibrary,
    clearCases,
    libraryOpen,
    setLibraryOpen,
    split,
    setSplit,
    shuffle,
    setShuffle,
    scorerKind,
    setScorerKind,
    metricCode,
    setMetricCode,
    scorerUrl,
    setScorerUrl,
    scorerSecret,
    setScorerSecret,
    scorerTimeout,
    setScorerTimeout,
    dryRun,
    runDryRun,
    strategyMode,
    setStrategyMode,
    engine,
    setEngine,
    engineCatalog,
    selectedEngine,
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
  };
}

export type BlackboxWizardContext = ReturnType<typeof useBlackboxWizard>;
