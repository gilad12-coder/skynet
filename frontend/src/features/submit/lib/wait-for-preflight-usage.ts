import type { WizardPreflightResponse } from "@/shared/types/wizard-preflight";
import type { ExecutionBudget } from "@/shared/types/execution-budget";

export const USAGE_WAIT_INTERVAL_MS = 5_000;
export const USAGE_WAIT_ATTEMPTS = 24;

function pause(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Preflight cancelled", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, USAGE_WAIT_INTERVAL_MS);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Wait for existing charges before retrieving the server's preserved validation evidence. */
export async function waitForPreflightUsage(
  response: WizardPreflightResponse,
  refresh: () => Promise<ExecutionBudget | null>,
  resume: (budget: ExecutionBudget) => Promise<WizardPreflightResponse>,
  signal?: AbortSignal,
  wait: (signal?: AbortSignal) => Promise<void> = pause,
  onAttempt?: (attempt: number, budget: ExecutionBudget) => void,
): Promise<WizardPreflightResponse> {
  if (response.status !== "pending" || response.pending_reason?.category !== "usage_reconciliation")
    return response;

  onAttempt?.(0, response.budget);
  // Poll read-only budget state; replaying validation while waiting can start another paid attempt.
  for (let attempt = 1; attempt <= USAGE_WAIT_ATTEMPTS; attempt += 1) {
    await wait(signal);
    signal?.throwIfAborted();
    const budget = await refresh();
    signal?.throwIfAborted();
    if (!budget) return response;
    onAttempt?.(attempt, budget);
    if (budget.pending_operations === 0) return resume(budget);
    response = { ...response, budget };
  }
  return response;
}
