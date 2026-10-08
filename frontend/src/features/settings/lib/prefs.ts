import type { ModelConfig } from "@/shared/types/api";

type CodeAssistDefault = "auto" | "manual";
type SplitModeDefault = "auto" | "manual";
type TrustModeDefault = "ask" | "auto_safe" | "yolo";

export interface UserPrefs {
  // Lightweight mode for low-resource machines: kills motion/blur and swaps the
  // heavy visualizations (charts, SVG trajectory tree, code editor) for static
  // equivalents. See LiteModeProvider.
  liteMode: boolean;
  wizardCodeAssist: CodeAssistDefault;
  wizardSplitMode: SplitModeDefault;
  agentTrustMode: TrustModeDefault;
  // AI co-tagging in the tagger: the master toggle (off = today's fully
  // manual tagger).
  taggerAssist: boolean;
  // Seed for new conversations (agent panel, code interview, tagger
  // interview): the composer-menu model id, or null for the catalog's
  // default. Per-conversation picks override it.
  composerModel: string | null;
  // Companion thinking level for composerModel; null runs the model default.
  composerEffort: string | null;
  // Shows/hides the dictation mic in the shared composer.
  dictationEnabled: boolean;
  // Seed for the assist model in new tagging sessions; empty name = the
  // server's default tagging model.
  taggerAssistModel: ModelConfig;
}

export type AgentPreferencePatch = Partial<
  Pick<
    UserPrefs,
    | "liteMode"
    | "wizardCodeAssist"
    | "wizardSplitMode"
    | "taggerAssist"
    | "dictationEnabled"
  >
>;

const AGENT_PREFERENCE_FIELDS: Record<string, keyof AgentPreferencePatch> = {
  lite_mode: "liteMode",
  wizard_code_assist: "wizardCodeAssist",
  wizard_split_mode: "wizardSplitMode",
  tagger_assist: "taggerAssist",
  dictation_enabled: "dictationEnabled",
};

function parsePreferenceResult(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return parsePreferenceResult(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.result !== undefined) return parsePreferenceResult(record.result);
  const updates = record.updates;
  return updates && typeof updates === "object" && !Array.isArray(updates)
    ? (updates as Record<string, unknown>)
    : null;
}

export function parseAgentPreferencePatch(value: unknown): AgentPreferencePatch {
  const updates = parsePreferenceResult(value);
  if (!updates) return {};

  const patch: AgentPreferencePatch = {};
  for (const [wireKey, rawValue] of Object.entries(updates)) {
    const localKey = AGENT_PREFERENCE_FIELDS[wireKey];
    if (!localKey) continue;
    if (localKey === "wizardCodeAssist" && (rawValue === "auto" || rawValue === "manual")) {
      Object.assign(patch, { [localKey]: rawValue });
    } else if (localKey === "wizardSplitMode" && (rawValue === "auto" || rawValue === "manual")) {
      Object.assign(patch, { [localKey]: rawValue });
    } else if (typeof rawValue === "boolean") {
      Object.assign(patch, { [localKey]: rawValue });
    }
  }
  return patch;
}

export const PREF_KEYS: Record<keyof UserPrefs, string> = {
  liteMode: "skynet.prefs.lite-mode",
  wizardCodeAssist: "skynet.prefs.wizard.code-assist",
  wizardSplitMode: "skynet.prefs.wizard.split-mode",
  agentTrustMode: "skynet.prefs.agent.trust-mode",
  taggerAssist: "skynet.prefs.tagger.assist",
  composerModel: "skynet.prefs.composer.model",
  composerEffort: "skynet.prefs.composer.effort",
  dictationEnabled: "skynet.prefs.composer.dictation",
  taggerAssistModel: "skynet.prefs.tagger.assist-model",
};

export const DEFAULT_PREFS: UserPrefs = {
  liteMode: false,
  wizardCodeAssist: "auto",
  wizardSplitMode: "auto",
  agentTrustMode: "ask",
  taggerAssist: true,
  // The backend runs the catalog's best-value default, which moves with
  // live prices and benchmarks.
  composerModel: null,
  composerEffort: null,
  dictationEnabled: true,
  taggerAssistModel: { name: "" },
};

// `skynet.prefs.advanced-mode` and `skynet.prefs.expand-advanced` belonged to
// retired toggles (the second is now the server-side Expert level); a stale
// value in an old browser is simply ignored.
export function migrateLegacyPrefs(): void {
  /* No pending migrations. Kept so callers don't churn when one appears. */
}

export function readPref<K extends keyof UserPrefs>(key: K): UserPrefs[K] {
  if (typeof window === "undefined") return DEFAULT_PREFS[key];
  try {
    const raw = window.localStorage.getItem(PREF_KEYS[key]);
    if (raw == null) return DEFAULT_PREFS[key];
    return JSON.parse(raw) as UserPrefs[K];
  } catch {
    return DEFAULT_PREFS[key];
  }
}

export function writePref<K extends keyof UserPrefs>(key: K, value: UserPrefs[K]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PREF_KEYS[key], JSON.stringify(value));
  } catch {
    /* noop */
  }
}
