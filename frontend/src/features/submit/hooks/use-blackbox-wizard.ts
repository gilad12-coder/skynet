"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  ValidateCodeResponse,
} from "@/shared/types/api";
import {
  dryRunScorer,
  getBlackboxEngines,
  getDatasetRows,
  isInsufficientCreditsError,
  isStorageQuotaError,
  submitBlackboxRun,
  type BlackboxAuthoringContext,
  type DatasetSummary,
} from "@/shared/lib/api";
import { readPref } from "@/features/settings";
import { useCodeAgent } from "@/shared/hooks/use-code-agent";
import { useCodeInterview } from "@/shared/hooks/use-code-interview";
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
export type BlackboxRecipe = BlackboxAuthoringContext["recipe"];

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
export const SCORER_TEMPLATE = `def score(candidate, case=None):
    """Return a number — higher is better. \`case\` is one row of your cases (or None)."""
    text = candidate if isinstance(candidate, str) else "\\n".join(candidate.values())
    return float(len(text.split()))
`;

// Editable starting points inserted into the python scorer editor. Presets are
// NOT a distinct scorer kind — the evaluator is always the user's own python.
// Those that grade a model's answer call the injected \`llm(candidate, input)\`
// helper: \`candidate\` is the version under optimization (the system prompt),
// the case's input column is the user message. Rename "input"/"expected" to
// your own column names.
export interface ScorerPreset {
  id: string;
  needsModel: boolean;
  code: string;
}

export const SCORER_PRESETS: ScorerPreset[] = [
  { id: "length", needsModel: false, code: SCORER_TEMPLATE },
  {
    id: "exact",
    needsModel: true,
    code: `def score(candidate, case=None):
    """1.0 when the model's answer exactly matches the expected column, else 0.0."""
    if case is None:
        return 0.0
    answer = llm(candidate, case.get("input", "")).strip()
    return 1.0 if answer == str(case.get("expected", "")).strip() else 0.0
`,
  },
  {
    id: "contains",
    needsModel: true,
    code: `def score(candidate, case=None):
    """1.0 when the expected text appears in the model's answer, else 0.0."""
    if case is None:
        return 0.0
    answer = llm(candidate, case.get("input", "")).lower()
    return 1.0 if str(case.get("expected", "")).strip().lower() in answer else 0.0
`,
  },
  {
    id: "numeric",
    needsModel: true,
    code: `import re


def score(candidate, case=None):
    """1.0 when the answer's last number is within TOLERANCE of the expected number."""
    if case is None:
        return 0.0
    TOLERANCE = 0.01
    answer = llm(candidate, case.get("input", ""))
    found = re.findall(r"-?\\d+(?:\\.\\d+)?", answer)
    if not found:
        return 0.0
    return 1.0 if abs(float(found[-1]) - float(case.get("expected", 0))) <= TOLERANCE else 0.0
`,
  },
  {
    id: "json_field",
    needsModel: true,
    code: `import json


def score(candidate, case=None):
    """1.0 when FIELD from the model's JSON answer equals the expected column."""
    if case is None:
        return 0.0
    FIELD = "answer"
    reply = llm(candidate, case.get("input", ""))
    try:
        parsed = json.loads(reply)
    except (ValueError, TypeError):
        return 0.0
    got = str(parsed.get(FIELD, "")).strip()
    return 1.0 if got == str(case.get("expected", "")).strip() else 0.0
`,
  },
  {
    id: "llm_judge",
    needsModel: true,
    code: `def score(candidate, case=None):
    """Ask the model to grade the answer 0-10, normalized to 0.0-1.0."""
    if case is None:
        return 0.0
    answer = llm(candidate, case.get("input", ""))
    rubric = (
        "Score how well the RESPONSE answers the INPUT from 0 to 10. "
        "Reply with only the number.\\n\\n"
        f"INPUT: {case.get('input', '')}\\n"
        f"EXPECTED: {case.get('expected', '')}\\n"
        f"RESPONSE: {answer}"
    )
    verdict = llm(rubric)
    digits = "".join(c for c in verdict if c.isdigit() or c == ".")
    try:
        return max(0.0, min(1.0, float(digits) / 10.0))
    except ValueError:
        return 0.0
`,
  },
  {
    id: "run_code",
    needsModel: false,
    code: `import os
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
`,
  },
  {
    id: "vlm_judge",
    needsModel: true,
    code: `import base64
import glob
import os
import re
import subprocess
import sys
import tempfile


def score(candidate, case=None):
    """Run the candidate as a program, then have a vision model grade what it rendered."""
    TIMEOUT_SECONDS = 120
    criteria = (case or {}).get("criteria") or "Rate what you see from 0 to 100."
    source = candidate if isinstance(candidate, str) else "\\n".join(candidate.values())
    with tempfile.TemporaryDirectory() as workdir:
        script = os.path.join(workdir, "candidate.py")
        with open(script, "w") as handle:
            handle.write(source)
        try:
            run = subprocess.run(
                [sys.executable, script], cwd=workdir, capture_output=True, text=True, timeout=TIMEOUT_SECONDS
            )
        except subprocess.TimeoutExpired:
            return 0.0, {"error": f"timed out after {TIMEOUT_SECONDS}s"}
        if run.returncode != 0:
            return 0.0, {"error": run.stderr.strip()[-2000:]}
        renders = sorted(glob.glob(os.path.join(workdir, "**", "*.png"), recursive=True))
        images = [_read(path) for path in renders]
    if not images:
        return 0.0, {"error": "the program saved no .png renders", "stdout": run.stdout[-2000:]}
    verdict = llm(
        f"{criteria}\\n\\nJudge the attached renders: say what works and what does not, "
        "then end with a line of the form 'SCORE: X/100'.",
        images=images,
    )
    match = re.search(r"SCORE:\\s*(\\d+(?:\\.\\d+)?)\\s*/\\s*(100|10)\\b", verdict)
    if not match:
        return 0.0, {"error": "the judge gave no SCORE: X/100 line", "verdict": verdict[-2000:]}
    side_info = {"feedback": verdict}
    for index, image in enumerate(images):
        side_info[f"render_{index + 1}"] = Image(base64_data=base64.b64encode(image).decode(), media_type="image/png")
    return max(0.0, min(1.0, float(match.group(1)) / float(match.group(2)))), side_info


def _read(path):
    with open(path, "rb") as handle:
        return handle.read()
`,
  },
];

const RUN_CODE_SCORER_TEMPLATE = SCORER_PRESETS.find((p) => p.id === "run_code")!.code;

const DEFAULT_MAX_SCORER_RUNS = 100;
const DEFAULT_PATIENCE = 40;

function parseOptionalNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function useBlackboxWizard(recipe: BlackboxRecipe) {
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
  // A program's natural yardstick is running it, so the code recipe opens on
  // the run-program scorer instead of the generic word-count template.
  const [metricCode, setMetricCode] = useState(
    recipe === "code" ? RUN_CODE_SCORER_TEMPLATE : SCORER_TEMPLATE,
  );
  const [scorerUrl, setScorerUrl] = useState("");
  const [scorerSecret, setScorerSecret] = useState("");
  const [scorerTimeout, setScorerTimeout] = useState(60);
  // The model injected into the python scorer as `llm()`. Empty until the user
  // picks one; a scorer that calls `llm()` without it fails the dry run.
  const [scorerModel, setScorerModel] = useState<ModelConfig>(emptyModelConfig());
  const [dryRun, setDryRun] = useState<DryRunState>({ status: "idle" });
  // Scorer fingerprint the in-flight/last dry run belongs to, so the reset
  // below doesn't wipe a run the agent kicked off for the code it just wrote.
  const dryRunKeyRef = useRef<string | null>(null);

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

  // A passed dry run only vouches for the scorer it ran against — including the
  // model bound to `llm()`, whose answers change what the scorer returns.
  const scorerKey = JSON.stringify([
    scorerKind,
    metricCode,
    scorerUrl,
    scorerSecret,
    scorerTimeout,
    scorerModel,
  ]);
  useEffect(() => {
    if (dryRunKeyRef.current === scorerKey) return;
    dryRunKeyRef.current = null;
    setDryRun({ status: "idle" });
    setScorerValidation(null);
  }, [scorerKey]);

  const seedCandidate = useMemo<BlackboxCandidate | null>(() => {
    if (seedMode === "none") return null;
    if (seedMode === "text") return seedText.trim() ? seedText : null;
    const parts = seedParts.filter((p) => p.key.trim() && p.value.trim());
    return parts.length ? Object.fromEntries(parts.map((p) => [p.key.trim(), p.value])) : null;
  }, [seedMode, seedText, seedParts]);

  const buildScorer = useCallback(
    (code: string = metricCode): BlackboxScorer =>
      scorerKind === "python"
        ? {
            kind: "python",
            metric_code: code,
            timeout_seconds: scorerTimeout,
            model: scorerModel.name.trim() ? prepareModelConfig(scorerModel) : null,
          }
        : {
            kind: "remote",
            url: scorerUrl.trim(),
            secret: scorerSecret.trim() || undefined,
            timeout_seconds: scorerTimeout,
          },
    [scorerKind, metricCode, scorerTimeout, scorerUrl, scorerSecret, scorerModel],
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

  // Also the agent's metric validator: it passes the code it just wrote (the
  // state update hasn't landed yet), the editor's Run button passes nothing.
  const runDryRun = useCallback(
    async (overrideCode?: string): Promise<ValidationResult | null> => {
      const code = typeof overrideCode === "string" ? overrideCode : metricCode;
      dryRunKeyRef.current = JSON.stringify([
        scorerKind,
        code,
        scorerUrl,
        scorerSecret,
        scorerTimeout,
        scorerModel,
      ]);
      setDryRun({ status: "running" });
      let outcome: ValidationResult;
      try {
        const result = await dryRunScorer({
          scorer: buildScorer(code),
          candidate: seedCandidate ?? objective,
          case: parsedCases?.rows[0] ?? null,
        });
        setDryRun({ status: "done", result });
        outcome = {
          valid: result.ok,
          errors: result.ok ? [] : [result.error ?? msg("submit.blackbox.scorer.dry_run_failed")],
          warnings: [],
        };
      } catch (err) {
        const error =
          err instanceof Error ? err.message : msg("submit.blackbox.scorer.dry_run_failed");
        setDryRun({ status: "done", result: { ok: false, error, side_info: {}, elapsed_ms: 0 } });
        outcome = { valid: false, errors: [error], warnings: [] };
      }
      setScorerValidation(outcome);
      return outcome;
    },
    [
      buildScorer,
      seedCandidate,
      objective,
      parsedCases,
      metricCode,
      scorerKind,
      scorerUrl,
      scorerSecret,
      scorerTimeout,
      scorerModel,
    ],
  );

  const authoringContext = useMemo<BlackboxAuthoringContext>(
    () => ({
      recipe,
      objective,
      background,
      target_kind: targetKind,
      scorer_has_model: scorerModel.name.trim().length > 0,
    }),
    [recipe, objective, background, targetKind, scorerModel.name],
  );

  // The interview is offered whatever the seed mode or hand edits: its brief
  // always yields a text starting point, so a parts or from-scratch seed
  // switches to Text when the draft lands (agentSetSeed below).
  const interviewPossible = codeAssistMode === "auto";
  // The interview opens the moment the Starting point is reached — drafting
  // the seed is its job, so it never waits for a typed objective. The seed
  // pass runs when it resolves, so the user leaves the step with a drafted
  // starting point instead of having to write one.
  const interviewEligible = interviewPossible && step >= 1;
  const interview = useCodeInterview({
    enabled: interviewEligible,
    parsedDataset: parsedCases,
    columnRoles: NO_ROLES,
    columnKinds: NO_KINDS,
    jobModel: targetKind === "agent" ? targetModel : reflectionModel.name,
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

  const validateStep = (s: number, showToast = false): boolean => {
    const fail = (key: Parameters<typeof msg>[0]) => {
      if (showToast) toast.error(msg(key));
      return false;
    };
    switch (s) {
      case 1: {
        // In auto mode the agent drafts the text seed from the objective, so
        // the objective is the required input and the seed may stay blank.
        const agentDrafts = codeAssistMode === "auto" && seedMode === "text";
        if ((seedMode === "none" || agentDrafts) && !objective.trim())
          return fail("submit.blackbox.validation.objective_required");
        if (seedMode !== "none" && !agentDrafts && seedCandidate == null)
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
        if (scorerKind === "python" && /\bllm\s*\(/.test(metricCode) && !scorerModel.name.trim())
          return fail("submit.blackbox.validation.scorer_model_required");
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
    recipe,
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
    scorerModel,
    setScorerModel,
    scorerValidation,
    dryRun,
    runDryRun,
    strategyMode,
    setStrategyMode,
    engine,
    setEngine,
    patience,
    setPatience,
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
