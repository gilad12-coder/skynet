import type { AgentMessage } from "@/shared/hooks/use-code-agent";

import type { WizardV2State } from "./wizard-v2";

/**
 * Where the open setup is kept for its tab, so a reload lands on the same
 * step with the same answers. A new name on purpose: the retired drafts'
 * keys are wiped on every visit.
 */
export const WIZARD_SESSION_KEY = "skynet.wizard.session.v1";

/**
 * What the setup's screens hold beside its answers, kept for the same tab and
 * read back only when the setup itself came back: the screen on view inside
 * the step, the Task step's Auto/Manual choice and the coding agent's chat.
 */
export const WIZARD_SCREEN_KEY = "skynet.wizard.screen.v1";
export const WIZARD_TASK_ASSIST_KEY = "skynet.wizard.task-assist.v1";
export const WIZARD_CODING_CHAT_KEY = "skynet.wizard.coding-chat.v1";
export const WIZARD_VIEW_KEYS = [
  WIZARD_SCREEN_KEY,
  WIZARD_TASK_ASSIST_KEY,
  WIZARD_CODING_CHAT_KEY,
] as const;

const SLICES = ["task", "inputs", "optimizer", "workspace", "meta"] as const;

/**
 * Serialize a setup for the tab's session storage.
 *
 * Args:
 *   account: Who the setup belongs to.
 *   state: The wizard's state.
 *
 * Returns:
 *   The stored text.
 */
export function encodeWizardSession(account: string, state: WizardV2State): string {
  return JSON.stringify({ account, state });
}

/**
 * Read back a setup kept for this tab, or nothing when it is missing,
 * malformed, from another account or from an older shape.
 *
 * Args:
 *   raw: The stored text, or null.
 *   account: The signed-in account.
 *   steps: The wizard's step ids.
 *
 * Returns:
 *   The setup, or null.
 */
export function decodeWizardSession(
  raw: string | null,
  account: string,
  steps: readonly string[],
): WizardV2State | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { account: owner, state } = parsed as { account?: unknown; state?: unknown };
  if (owner !== account || !state || typeof state !== "object") return null;
  const s = state as Record<string, unknown>;
  if (typeof s.step !== "string" || !steps.includes(s.step)) return null;
  if (typeof s.furthestStep !== "string" || !steps.includes(s.furthestStep)) return null;
  if (!SLICES.every((slice) => s[slice] && typeof s[slice] === "object")) return null;
  return state as WizardV2State;
}

/**
 * Read one of the tab's saved values, or null when storage is blocked.
 *
 * Args:
 *   key: The session storage key.
 *
 * Returns:
 *   The stored text, or null.
 */
export function readSessionValue(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Keep a value for the tab; full or blocked storage just drops it.
 *
 * Args:
 *   key: The session storage key.
 *   value: The text to keep.
 */
export function keepSessionValue(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {}
}

/**
 * The index of the screen a reload reopens inside the step: the saved one
 * while the step still has it, else the step's first.
 *
 * Args:
 *   screens: The step's screens, in order.
 *   saved: The screen on view before the reload, or null.
 *
 * Returns:
 *   The screen's index.
 */
export function reopenedPage(screens: readonly string[], saved: string | null): number {
  return saved === null ? 0 : Math.max(0, screens.indexOf(saved));
}

/**
 * Read back the Task step's Auto/Manual choice; anything else is Auto.
 *
 * Args:
 *   raw: The stored text, or null.
 *
 * Returns:
 *   The choice.
 */
export function decodeTaskAssist(raw: string | null): "auto" | "manual" {
  return raw === "manual" ? "manual" : "auto";
}

/**
 * Read back the coding agent's saved chat, or none when it is missing or
 * malformed.
 *
 * Args:
 *   raw: The stored text, or null.
 *
 * Returns:
 *   The chat's messages.
 */
export function decodeCodingChat(raw: string | null): AgentMessage[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const valid = parsed.every((item: unknown) => {
    if (!item || typeof item !== "object") return false;
    const { role, content } = item as Record<string, unknown>;
    return (role === "user" || role === "assistant") && typeof content === "string";
  });
  return valid ? (parsed as AgentMessage[]) : [];
}
