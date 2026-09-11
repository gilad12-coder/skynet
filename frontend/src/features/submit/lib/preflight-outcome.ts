import type { PreflightScope, WizardPreflightResponse } from "@/shared/types/wizard-preflight";

export interface StoredPreflightEvidence {
  identity: string;
  response: WizardPreflightResponse;
}

/** Return completed success only when it attests this exact scope and input identity. */
export function reusableSuccessfulPreflight(
  evidence: Partial<Record<PreflightScope, StoredPreflightEvidence>>,
  scope: PreflightScope,
  identity: string,
): WizardPreflightResponse | null {
  const candidate = evidence[scope];
  return candidate?.identity === identity &&
    candidate.response.status === "succeeded" &&
    candidate.response.may_advance
    ? candidate.response
    : null;
}

/**
 * Reuse a settled outcome -- a pass that may advance, or a confirmed failure --
 * for the same scope and input identity, so a config already checked is not
 * checked again. A pending result is never reused: it is still waiting on
 * something a fresh run may resolve.
 */
export function reusableTerminalPreflight(
  evidence: Partial<Record<PreflightScope, StoredPreflightEvidence>>,
  scope: PreflightScope,
  identity: string,
): WizardPreflightResponse | null {
  const candidate = evidence[scope];
  if (candidate?.identity !== identity) return null;
  if (candidate.response.status === "failed") return candidate.response;
  return reusableSuccessfulPreflight(evidence, scope, identity);
}

/** Advance only on server-attested success or the one safe later-stage dependency. */
export function preflightMayAdvance(
  response: WizardPreflightResponse,
  scope: PreflightScope,
): boolean {
  if (!response.may_advance) return false;
  if (response.status === "succeeded") return true;
  return (
    scope === "evaluation" &&
    response.status === "pending" &&
    response.pending_reason?.category === "later_stage_dependency"
  );
}

/** Select localized terminal copy from the server's structured pending category. */
export function preflightPendingMessageKey(
  response: WizardPreflightResponse,
): "submit.preflight.deferred" | "submit.preflight.usage_pending" | "submit.preflight.incomplete" {
  if (response.pending_reason?.category === "later_stage_dependency")
    return "submit.preflight.deferred";
  if (response.pending_reason?.category === "usage_reconciliation")
    return "submit.preflight.usage_pending";
  return "submit.preflight.incomplete";
}
