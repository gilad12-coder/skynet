/**
 * Property shaping for the wizard funnel events.
 *
 * `wizard_step_viewed` fires once per step change; `setup_check_failed` once
 * per failed preflight or contract check. Drop-off is not an event: it is the
 * last step viewed in a session with no `run_submitted` after it, derived in
 * SQL. Properties carry structural codes only, never error text or anything
 * the user typed, because telemetry stores them verbatim.
 */
import type { ExperienceLevel } from "@/features/experience";
import type { WizardStepId } from "./wizard-v2";

// Fixed positions, so `index` means the same step whichever steps a level shows.
const STEP_INDEX: Readonly<Record<WizardStepId, number>> = {
  task: 0,
  inputs: 1,
  optimizer: 2,
  metric: 3,
};

export interface WizardStepViewedProps {
  step: WizardStepId;
  index: number;
  mode: ExperienceLevel;
}

export interface SetupCheckFailedProps {
  check: "preflight" | "contract";
  code: string;
}

/** Code for a check that failed without a result: transport, auth, or budget. */
export const REQUEST_FAILED_CODE = "request_failed";
/** Code for a failed result that names no failed check. */
export const UNKNOWN_FAILURE_CODE = "unknown";

// Check keys are dotted snake_case identifiers; anything else might be text.
const CODE_PATTERN = /^[a-z][a-z0-9_.]{0,79}$/;

function structuralCode(key: unknown): string {
  return typeof key === "string" && CODE_PATTERN.test(key) ? key : UNKNOWN_FAILURE_CODE;
}

/**
 * Remember the last step reported and return the event properties only when
 * the step has changed, so a re-render on the same step reports nothing.
 *
 * Returns:
 *   A `(step, mode) => props | null` function; the first call always reports.
 */
export function createStepViewTracker(): (
  step: WizardStepId,
  mode: ExperienceLevel,
) => WizardStepViewedProps | null {
  let last: WizardStepId | null = null;
  return (step, mode) => {
    if (step === last) return null;
    last = step;
    return { step, index: STEP_INDEX[step], mode };
  };
}

interface CheckLike {
  key: string;
  status: string;
}

function firstFailedKey(checks: readonly CheckLike[] | undefined): string {
  const failed = checks?.find((check) => check.status === "failed");
  return structuralCode(failed?.key);
}

/**
 * Properties for a preflight that went from running to failed, else null.
 *
 * Args:
 *   previous: the status last seen for this workflow.
 *   current: the status now, with the response when the server answered.
 */
export function preflightFailure(
  previous: string | undefined,
  current: { status?: string; response?: { checks?: readonly CheckLike[] } } | null | undefined,
): SetupCheckFailedProps | null {
  if (previous !== "running" || current?.status !== "failed") return null;
  const code = current.response ? firstFailedKey(current.response.checks) : REQUEST_FAILED_CODE;
  return { check: "preflight", code };
}

/**
 * Properties for a finished contract check that failed, else null.
 *
 * Args:
 *   result: the sandboxed check's result, or null when the request failed.
 */
export function contractFailure(
  result: { ok: boolean; checks?: readonly CheckLike[] } | null,
): SetupCheckFailedProps | null {
  if (result === null) return { check: "contract", code: REQUEST_FAILED_CODE };
  if (result.ok) return null;
  return { check: "contract", code: firstFailedKey(result.checks) };
}
