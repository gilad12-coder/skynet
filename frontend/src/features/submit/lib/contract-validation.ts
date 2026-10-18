/**
 * Reads a sandboxed contract check as the setup-check screen's progress, so
 * the wizard's sandbox check keeps the screen it always had: the budget step,
 * the sandbox boot, then the evaluator step that runs the code and metric on
 * the samples.
 */
import type { ContractCheckItem, ContractCheckResponse } from "@/shared/types/unified-run";
import type { WizardPreflightResponse } from "@/shared/types/wizard-preflight";
import type { ValidationPhase, ValidationProgress } from "./preflight-store";

/** The steps a contract check walks: reserve the budget, boot the sandbox, score the samples. */
export const CONTRACT_CHECK_PLAN: readonly ValidationPhase[] = ["budget", "sandbox", "evaluator"];

/** When the running check reached each step; absent for a result restored with a draft. */
export interface ContractCheckTiming {
  startedAt: number;
  /** When the budget was in hand and the sandboxed request went out. */
  requestAt?: number;
  /** When the server reported the sandbox boot had started. */
  sandboxAt?: number;
  /** When the server reported the sandbox was warm and scoring had started. */
  evaluatorAt?: number;
  finishedAt?: number;
}

/**
 * The step a running check stands in, for the compact label under the IDE's
 * Check button, or null when no check is running.
 */
export function activeContractPhase(
  timing: ContractCheckTiming | null,
  checking: boolean,
): ValidationPhase | null {
  if (!checking || !timing) return null;
  if (timing.evaluatorAt) return "evaluator";
  if (timing.sandboxAt) return "sandbox";
  return "budget";
}

const STATUS: Record<
  ContractCheckItem["status"],
  WizardPreflightResponse["checks"][number]["status"]
> = {
  passed: "succeeded",
  failed: "failed",
  pending: "pending",
  skipped: "skipped",
};

function meanScore(result: ContractCheckResponse): number | undefined {
  const scores = result.samples
    .map((sample) => sample.score)
    .filter((score): score is number => typeof score === "number");
  if (scores.length === 0) return undefined;
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

/**
 * The progress the check screen shows, or null when no check has run.
 *
 * `message` renders one check item in the active locale; it is passed in
 * because the message catalog cannot load in the plain-module tests.
 */
export function contractValidation({
  result,
  checking,
  error,
  timing,
  message,
}: {
  result: ContractCheckResponse | null;
  checking: boolean;
  error: string | null;
  timing: ContractCheckTiming | null;
  message: (item: ContractCheckItem) => string;
}): ValidationProgress | null {
  if (!checking && !error && !result) return null;
  // A result restored with a draft has no timing; its steps read as instant.
  const startedAt = timing?.startedAt ?? 0;
  const finishedAt = checking ? undefined : (timing?.finishedAt ?? startedAt);
  const sandboxAt = timing ? timing.sandboxAt : startedAt;
  // A check refused before the sandbox woke (static mismatch, spent budget)
  // ends on the budget step; later steps appear as the server reports them.
  const evaluatorAt = timing?.evaluatorAt ?? (timing ? undefined : startedAt);
  const phases: ValidationProgress["phases"] = [
    { key: "budget", startedAt, finishedAt: sandboxAt ?? finishedAt },
  ];
  if (sandboxAt !== undefined)
    phases.push({ key: "sandbox", startedAt: sandboxAt, finishedAt: evaluatorAt ?? finishedAt });
  if (evaluatorAt !== undefined) phases.push({ key: "evaluator", startedAt: evaluatorAt, finishedAt });

  const shown = checking || error ? null : result;
  const score = shown ? meanScore(shown) : undefined;
  // The screen reads the preflight response's checks and sample score; a
  // contract check carries nothing else it shows.
  const response = shown
    ? ({
        checks: shown.checks.map((item) => ({
          key: item.key,
          status: STATUS[item.status],
          message: message(item),
        })),
        scorer_result: score === undefined ? undefined : { score },
      } as unknown as WizardPreflightResponse)
    : undefined;

  return {
    workflow: "unified",
    scope: "execution",
    identity: shown?.fingerprint ?? "",
    owner: null,
    status: checking ? "running" : error || !shown?.ok ? "failed" : "succeeded",
    startedAt,
    finishedAt,
    phases,
    response,
    message: checking ? undefined : (error ?? undefined),
  };
}
