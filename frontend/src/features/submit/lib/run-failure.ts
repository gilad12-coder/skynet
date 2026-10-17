import type { WizardPreflightResponse } from "@/shared/types/wizard-preflight";

/** The key the server gives a check the budget refused (`BUDGET_CHECK_KEY`). */
const BUDGET_CHECK_KEY = "budget";
/** The field a refused budget check names when the account balance, not the limit, refused it (`BALANCE_FIELD`). */
const BALANCE_FIELD = "balance";

/**
 * What stopped the run, and so what the user can change: the spending limit,
 * the account balance, or something else in the setup.
 */
export type RunFailureCause = "limit" | "balance" | "other";

/**
 * Why the last Run click did not start a run. It stays under Run because a
 * toast is easy to miss, and a second click on the same setup only replays
 * the same settled answer.
 */
export interface RunFailure {
  /** The setup the check ran on; once the setup or its limit changes, the failure no longer applies. */
  identity: string;
  cause: RunFailureCause;
  /** The server's account of the failure, or null when it gave none. */
  detail: string | null;
}

/** The failure a settled setup check reports, read from its first failed check. */
export function runFailureFromCheck(
  identity: string,
  response: Pick<WizardPreflightResponse, "checks">,
): RunFailure {
  const failed = response.checks.find((check) => check.status === "failed");
  const cause: RunFailureCause =
    failed?.key !== BUDGET_CHECK_KEY
      ? "other"
      : failed.field === BALANCE_FIELD
        ? "balance"
        : "limit";
  return { identity, cause, detail: failed?.message?.trim() || null };
}

/** A check that could not run at all: the request failed before any check settled. */
export function runFailureFromError(identity: string, message: string | null): RunFailure {
  return { identity, cause: "other", detail: message?.trim() || null };
}

/** The failure to show for the setup as it stands now, or null when it was for another one. */
export function currentRunFailure(failure: RunFailure | null, identity: string): RunFailure | null {
  return failure?.identity === identity ? failure : null;
}
