import type { RunBillingOutcome } from "@/shared/types/api";
import type { JobExecutionBudget } from "@/shared/types/execution-budget";

/**
 * Read the typed billing stamp the worker writes under `result.details.billing`.
 *
 * Returns the validated stamp, or `null` when the run hasn't settled or the
 * stamp is malformed — so callers can treat "no billing yet" and "no chip"
 * identically. Only `outcome === "billed"` is accepted: every run bills, and a
 * legacy "refunded" stamp (from the retired no-lift guarantee) is ignored
 * rather than rendered as a charge it never was.
 *
 * @param details The run result's `details` bag, or `undefined`.
 * @returns The parsed billing stamp, or `null` when absent/invalid.
 */
export function readBilling(
  details: Record<string, unknown> | undefined,
): RunBillingOutcome | null {
  const billing = details?.billing;
  if (
    billing &&
    typeof billing === "object" &&
    "cents" in billing &&
    (billing as RunBillingOutcome).outcome === "billed"
  ) {
    return billing as RunBillingOutcome;
  }
  return null;
}

/**
 * Cents to show as a run's cost in the detail header.
 *
 * Prefers the worker's billing stamp. Budget-ledger runs (sandbox runs, and
 * any run charged per operation) never get that stamp, so their figure comes
 * from the execution budget: what the wallet was billed once the run settles,
 * or the wallet spend so far while it is still running.
 *
 * @param details The run result's `details` bag, or `undefined`.
 * @param budget The run's execution budget snapshot, or `undefined`.
 * @param running Whether the run is still active.
 * @returns The cents to show, or `null` when the run has no charge yet.
 */
export function runCostCents(
  details: Record<string, unknown> | undefined,
  budget: JobExecutionBudget | null | undefined,
  running: boolean,
): number | null {
  const billing = readBilling(details);
  if (billing != null) return billing.cents;
  if (budget == null) return null;
  const cents = running
    ? Number(budget.wallet_setup_spent_cents) + Number(budget.wallet_run_spent_cents)
    : budget.billed_cents;
  return Number.isFinite(cents) && cents > 0 ? cents : null;
}
