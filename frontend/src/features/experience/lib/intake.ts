/*
 * The first-login setup: three questions, then a summary. Everything here is
 * pure so the answers → level → server payload → wizard prefill path can be
 * tested without a browser.
 */

import type {
  AccountExperiencePatch,
  ConnectorProvider,
  NotificationCadence,
  NotificationLiveMode,
  NotificationPreferences,
} from "@/shared/lib/api";

import type { ExperienceLevel } from "./abstraction";

/** Where the thing to improve lives (question 2). */
export type IntakeSourceKind = "repo" | "api" | "spreadsheet" | "file" | "dataset";

export type IntakeConnectorState = "connected" | "later" | "none";

export interface IntakeNotifications {
  cadence: NotificationCadence;
  live_mode: NotificationLiveMode;
  live_count: number;
  digest_minutes: number;
  stuck_fraction: number;
  budget_alert_fraction: number;
}

export interface IntakeAnswers {
  /** Question 1: what should get better and how the user will know. */
  goal: string;
  /** Question 2. */
  source: IntakeSourceKind | null;
  /** The pasted repo / API link, when the source has one. */
  source_url: string;
  connector: IntakeConnectorState;
  /** Question 3: catalog model ids. */
  models: string[];
  billing: "platform" | "byok";
  /** Vault provider slug of the key the user brought, when they did. */
  byok_provider: string | null;
  level: ExperienceLevel;
  /** True once the user picked the level on the summary instead of keeping the guess. */
  level_chosen: boolean;
  /** Spending limit in cents; null = the wizard's own default. */
  spending_limit_cents: number | null;
  /** Wall-clock deadline in hours; null = no deadline. */
  deadline_hours: number | null;
  notifications: IntakeNotifications;
}

export const DEFAULT_NOTIFICATIONS: IntakeNotifications = {
  cadence: "done",
  live_mode: "per_stage",
  live_count: 3,
  digest_minutes: 60,
  stuck_fraction: 0.25,
  budget_alert_fraction: 0.8,
};

/*
 * A fresh setup leaves the spending limit to the wizard, which seeds it from
 * the run's own cost estimate: a guessed number here would change what the
 * run does without the user having chosen it.
 */
export const DEFAULT_SPENDING_LIMIT_CENTS: number | null = null;
export const DEFAULT_DEADLINE_HOURS: number | null = null;

export function emptyIntake(): IntakeAnswers {
  return {
    goal: "",
    source: null,
    source_url: "",
    connector: "none",
    models: [],
    billing: "platform",
    byok_provider: null,
    level: "standard",
    level_chosen: false,
    spending_limit_cents: DEFAULT_SPENDING_LIMIT_CENTS,
    deadline_hours: DEFAULT_DEADLINE_HOURS,
    notifications: { ...DEFAULT_NOTIFICATIONS },
  };
}

const SOURCES: readonly IntakeSourceKind[] = ["repo", "api", "spreadsheet", "file", "dataset"];
const CADENCES: readonly NotificationCadence[] = ["done", "milestones", "live"];
const LIVE_MODES: readonly NotificationLiveMode[] = ["per_stage", "per_run_count", "digest"];

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

/** Read stored answers back, tolerating any shape an older build or the server returns. */
export function parseIntakeAnswers(value: unknown): IntakeAnswers | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const base = emptyIntake();
  const notes =
    raw.notifications && typeof raw.notifications === "object"
      ? (raw.notifications as Record<string, unknown>)
      : {};
  const level = raw.level;
  return {
    goal: typeof raw.goal === "string" ? raw.goal : "",
    source: SOURCES.find((s) => s === raw.source) ?? null,
    source_url: typeof raw.source_url === "string" ? raw.source_url : "",
    connector: raw.connector === "connected" || raw.connector === "later" ? raw.connector : "none",
    models: Array.isArray(raw.models)
      ? raw.models.filter((m): m is string => typeof m === "string" && m.length > 0)
      : [],
    billing: raw.billing === "byok" ? "byok" : "platform",
    byok_provider: typeof raw.byok_provider === "string" ? raw.byok_provider : null,
    level: level === "guided" || level === "expert" ? level : "standard",
    level_chosen: raw.level_chosen === true,
    spending_limit_cents:
      raw.spending_limit_cents === null
        ? null
        : typeof raw.spending_limit_cents === "number" && raw.spending_limit_cents > 0
          ? Math.round(raw.spending_limit_cents)
          : base.spending_limit_cents,
    deadline_hours:
      typeof raw.deadline_hours === "number" && raw.deadline_hours > 0 ? raw.deadline_hours : null,
    notifications: {
      cadence: CADENCES.find((c) => c === notes.cadence) ?? DEFAULT_NOTIFICATIONS.cadence,
      live_mode: LIVE_MODES.find((m) => m === notes.live_mode) ?? DEFAULT_NOTIFICATIONS.live_mode,
      live_count: Math.round(clamp(notes.live_count, 1, 20, DEFAULT_NOTIFICATIONS.live_count)),
      digest_minutes: Math.round(
        clamp(notes.digest_minutes, 15, 1440, DEFAULT_NOTIFICATIONS.digest_minutes),
      ),
      stuck_fraction: clamp(notes.stuck_fraction, 0.05, 1, DEFAULT_NOTIFICATIONS.stuck_fraction),
      budget_alert_fraction: clamp(
        notes.budget_alert_fraction,
        0.1,
        1,
        DEFAULT_NOTIFICATIONS.budget_alert_fraction,
      ),
    },
  };
}

/** A GitHub link (or bare owner/name) pasted as the answer to "Where does it live?". */
const GITHUB_REPO = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?(?:[/?#].*)?$/i;
const BARE_REPO = /^[\w.-]+\/[\w.-]+$/;
const HTTP_URL = /^https?:\/\/\S+$/i;

/** Classify pasted text: a GitHub repository, an HTTP endpoint, or nothing recognizable. */
export function classifySourceText(text: string): { kind: "repo" | "api"; value: string } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const github = GITHUB_REPO.exec(trimmed);
  if (github?.[1]) return { kind: "repo", value: github[1] };
  if (BARE_REPO.test(trimmed)) return { kind: "repo", value: trimmed };
  if (HTTP_URL.test(trimmed)) return { kind: "api", value: trimmed };
  return null;
}

/*
 * Words that only someone who already drives optimizers types unprompted:
 * engine and optimizer names, sampling parameters. Matched as whole words so
 * "temperature" in a weather goal still counts, which is fine: it costs a
 * Standard user nothing to see the Expert defaults and they can change it.
 */
const EXPERT_TERMS =
  /\b(gepa|mipro(?:v2)?|copro|simba|bootstrap\s*few[- ]?shot|shinka(?:evolve)?|openevolve|autoresearch|best[- _]of[- _]n|meta[- _]harness|temperature|top[- _]?p|top[- _]?k|max[- _]tokens|reasoning[- _]effort|few[- ]shot|grid\s*search|hyperparam\w*|islands?|mutation\s*rate)\b/i;

/** The level the answers point to: data without code → Guided, a repo or API → Standard, engine talk → Expert. */
export function inferLevel(answers: Pick<IntakeAnswers, "goal" | "source">): ExperienceLevel {
  if (EXPERT_TERMS.test(answers.goal)) return "expert";
  if (answers.source === "repo" || answers.source === "api") return "standard";
  return "guided";
}

/** The one connector a source implies, or null when it needs none. */
export function connectorFor(source: IntakeSourceKind | null): ConnectorProvider | null {
  if (source === "repo") return "github";
  if (source === "spreadsheet") return "google_sheets";
  if (source === "dataset") return "huggingface";
  return null;
}

/** The `/submit?recipe=` the setup opens. */
export function recipeFor(source: IntakeSourceKind | null): "program" | "repo" | "anything" {
  if (source === "repo") return "repo";
  if (source === "api") return "anything";
  return "program";
}

/** The account-experience PATCH that finishes the setup. */
export function buildExperiencePatch(answers: IntakeAnswers): AccountExperiencePatch {
  return {
    level: answers.level,
    intake: { ...answers, version: 1 } as unknown as Record<string, unknown>,
    intake_completed: true,
  };
}

/** What Skip sends: today's app, and never ask again. */
export const SKIP_PATCH: AccountExperiencePatch = { level: "standard", intake_completed: true };

/** Read the server's preferences into the editable shape; absent fields take the defaults. */
export function notificationsFromPrefs(
  prefs: Partial<NotificationPreferences> | null | undefined,
): IntakeNotifications {
  return parseIntakeAnswers({ notifications: prefs ?? {} })?.notifications ?? {
    ...DEFAULT_NOTIFICATIONS,
  };
}

/** The notification-preferences PATCH; Live's sub-settings only travel with Live. */
export function buildNotificationPatch(
  notifications: IntakeNotifications,
): Partial<NotificationPreferences> {
  const patch: Partial<NotificationPreferences> = {
    cadence: notifications.cadence,
    stuck_fraction: notifications.stuck_fraction,
    budget_alert_fraction: notifications.budget_alert_fraction,
  };
  if (notifications.cadence === "live") {
    patch.live_mode = notifications.live_mode;
    if (notifications.live_mode === "per_run_count") patch.live_count = notifications.live_count;
    if (notifications.live_mode === "digest") patch.digest_minutes = notifications.digest_minutes;
  }
  return patch;
}

/**
 * The shared-wizard patch the setup applies before opening `/submit` — the
 * same path the agent's writes take. Only fields the answers decide are set;
 * everything else keeps the wizard's defaults.
 */
export function buildWizardPrefill(answers: IntakeAnswers): Record<string, unknown> {
  const recipe = recipeFor(answers.source);
  const patch: Record<string, unknown> = {
    job_type: recipe === "program" ? "run" : "blackbox",
  };
  const goal = answers.goal.trim();
  if (recipe !== "program" && goal) patch.blackbox_objective = goal;
  const model = answers.models[0];
  if (model) {
    const config = { name: model };
    if (recipe === "program") patch.model_config = config;
    else patch.reflection_model_config = config;
  }
  if (answers.spending_limit_cents !== null) patch.max_cost_cents = answers.spending_limit_cents;
  return patch;
}

/** The message handed to the agent so it can fill what the three answers leave open. */
export function agentBrief(
  answers: IntakeAnswers,
  template: (values: Record<string, string>) => string,
): string | null {
  const goal = answers.goal.trim();
  if (!goal) return null;
  return template({
    goal,
    source: answers.source_url.trim() || answers.source || "",
    models: answers.models.join(", "),
  });
}
