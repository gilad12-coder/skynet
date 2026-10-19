/*
 * Pure helpers for the Continuous tab: form checks that mirror the backend's
 * enable rules, and how a check's outcome reads in the history.
 */

import type {
  ContinuousCycle,
  ContinuousCycleStatus,
  ContinuousPermitted,
  ContinuousPlan,
  ContinuousUsage,
} from "@/shared/types/continuous";

/** Visual weight of a check's outcome. */
export type CycleTone = "good" | "warn" | "bad" | "muted" | "busy";

const TONES: Record<ContinuousCycleStatus, CycleTone> = {
  checking: "busy",
  optimizing: "busy",
  awaiting_review: "good",
  approved: "good",
  skipped: "muted",
  rejected: "muted",
  paused: "warn",
  regressed: "warn",
  failed: "bad",
};

export function cycleTone(status: ContinuousCycleStatus): CycleTone {
  return TONES[status] ?? "muted";
}

/** Only a validated candidate waits for the owner's approve or reject. */
export function canReview(cycle: ContinuousCycle): boolean {
  return cycle.status === "awaiting_review" && !!cycle.optimization_id;
}

const DUE_REFRESH_MS = 5_000;
const RUN_REFRESH_MS = 30_000;
// Far-off checks are re-armed daily; a longer setTimeout delay overflows.
const MAX_WAIT_MS = 86_400_000;

/**
 * How long to wait before reloading the plan so the history shows a check's
 * outcome without a page reload; null when nothing is pending. A due check
 * (after "Check now", or a scheduled time that passed) or one still checking
 * is a sweep away, while a run takes minutes. A tab left open waits for the
 * next scheduled check.
 */
export function refreshDelayMs(plan: ContinuousPlan, now: number): number | null {
  if (plan.cycles.some((c) => c.status === "checking")) return DUE_REFRESH_MS;
  const due = plan.next_check_at ? Date.parse(plan.next_check_at) : Number.NaN;
  if (plan.status === "active" && due <= now) return DUE_REFRESH_MS;
  if (plan.cycles.some((c) => c.status === "optimizing")) return RUN_REFRESH_MS;
  if (plan.status === "active" && due > now)
    return Math.min(due - now + DUE_REFRESH_MS, MAX_WAIT_MS);
  return null;
}

/** Share of this month's allowance already committed, clamped to 0..1. */
export function allowanceShare(usage: ContinuousUsage): number {
  if (usage.limit_cents == null) return 0;
  if (usage.limit_cents <= 0) return 1;
  return Math.min(1, Math.max(0, usage.committed_cents / usage.limit_cents));
}

export interface EnableForm {
  permitted: ContinuousPermitted;
  sourceRef: string;
}

/** Why the enable form cannot be sent, as a UI message key; null when it can. */
export type EnableProblem =
  | "continuous_tab.form.need_permission"
  | "continuous_tab.form.need_source";

export function enableProblem(form: EnableForm): EnableProblem | null {
  const { data, models, optimizers } = form.permitted;
  if (!data && !models && !optimizers) return "continuous_tab.form.need_permission";
  if (data && !form.sourceRef.trim()) return "continuous_tab.form.need_source";
  return null;
}
