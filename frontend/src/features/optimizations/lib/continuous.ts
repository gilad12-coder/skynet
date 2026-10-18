/*
 * Pure helpers for the Continuous tab: form checks that mirror the backend's
 * enable rules, and how a check's outcome reads in the history.
 */

import type {
  ContinuousCycle,
  ContinuousCycleStatus,
  ContinuousPermitted,
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

/** Share of this month's allowance already committed, clamped to 0..1. */
export function allowanceShare(usage: ContinuousUsage): number {
  if (usage.limit_cents <= 0) return 1;
  return Math.min(1, Math.max(0, usage.committed_cents / usage.limit_cents));
}

/** Parse a dollar amount typed by the owner into whole cents; null when invalid. */
export function usdTextToCents(text: string): number | null {
  const trimmed = text.trim().replace(/^\$/, "");
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const cents = Math.round(Number(trimmed) * 100);
  return cents > 0 ? cents : null;
}

export interface EnableForm {
  permitted: ContinuousPermitted;
  sourceRef: string;
  monthlyLimit: string;
  cycleBudget: string;
}

/** Why the enable form cannot be sent, as a UI message key; null when it can. */
export type EnableProblem =
  | "continuous_tab.form.need_permission"
  | "continuous_tab.form.need_source"
  | "continuous_tab.form.bad_amount"
  | "continuous_tab.form.budget_over_limit";

export function enableProblem(form: EnableForm): EnableProblem | null {
  const { data, models, optimizers } = form.permitted;
  if (!data && !models && !optimizers) return "continuous_tab.form.need_permission";
  if (data && !form.sourceRef.trim()) return "continuous_tab.form.need_source";
  const limit = usdTextToCents(form.monthlyLimit);
  const budget = usdTextToCents(form.cycleBudget);
  if (limit == null || budget == null) return "continuous_tab.form.bad_amount";
  if (budget > limit) return "continuous_tab.form.budget_over_limit";
  return null;
}
