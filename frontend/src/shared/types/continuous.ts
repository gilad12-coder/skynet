/**
 * Continuous optimization wire types (`/optimizations/{id}/continuous`,
 * `/continuous/{planId}/…`). A plan rechecks a successful run on a schedule
 * and starts a fresh run only when a permitted input changed.
 */

export type ScheduleFrequency = "hourly" | "daily" | "weekly" | "monthly";

/**
 * When a plan checks: every `every` hours/days/weeks/months at `time` (HH:MM)
 * in `timezone`. Weekly rules use `weekdays` (Monday = 0); monthly rules use
 * `month_day`, which falls on the last day of shorter months. Hourly rules use
 * the minute of `time`, counting hours from its hour.
 */
export interface ScheduleRule {
  frequency: ScheduleFrequency;
  every: number;
  time: string;
  weekdays: number[];
  month_day: number;
  timezone: string;
}

export interface ContinuousSchedulePreview {
  next_checks: string[];
}

export type ContinuousCycleStatus =
  | "checking"
  | "skipped"
  | "failed"
  | "paused"
  | "optimizing"
  | "regressed"
  | "awaiting_review"
  | "approved"
  | "rejected";

export interface ContinuousPermitted {
  data: boolean;
  models: boolean;
  optimizers: boolean;
}

export interface ContinuousSource {
  provider: string;
  ref: string;
}

export interface ContinuousCycle {
  id: string;
  slot: string;
  month: string;
  status: ContinuousCycleStatus;
  changes: string[];
  detail_code: string | null;
  detail_params: Record<string, unknown>;
  snapshot: Record<string, unknown> | null;
  optimization_id: string | null;
  incumbent_score: number | null;
  candidate_score: number | null;
  spent_cents: number | null;
  created_at: string;
}

export interface ContinuousUsage {
  month: string;
  limit_cents: number;
  committed_cents: number;
  resets_at: string;
}

export interface ContinuousPlan {
  id: string;
  source_optimization_id: string;
  incumbent_optimization_id: string;
  status: "active" | "paused";
  /** `user` (the owner paused it), `allowance` (monthly limit spent) or `funds` (wallet too low). */
  pause_reason: "user" | "allowance" | "funds" | null;
  schedule: ScheduleRule;
  next_check_at: string | null;
  /** The next few check times, earliest first; empty while paused. */
  upcoming_checks: string[];
  permitted: ContinuousPermitted;
  source: ContinuousSource | null;
  pending_inputs: Record<string, string>;
  cycle_budget_cents: number;
  usage: ContinuousUsage;
  cycles: ContinuousCycle[];
}

export interface ContinuousState {
  plan: ContinuousPlan | null;
  eligible: boolean;
}

export interface ContinuousEnableRequest {
  schedule: ScheduleRule;
  permitted: ContinuousPermitted;
  source: ContinuousSource | null;
  monthly_limit_cents: number;
  cycle_budget_cents: number;
}

export interface ContinuousInputs {
  task_model?: string;
  reflection_model?: string;
  optimizer?: string;
}
