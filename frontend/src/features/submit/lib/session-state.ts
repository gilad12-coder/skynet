import type { WizardV2State } from "./wizard-v2";

/**
 * Where the open setup is kept for its tab, so a reload lands on the same
 * step with the same answers. A new name on purpose: the retired drafts'
 * keys are wiped on every visit.
 */
export const WIZARD_SESSION_KEY = "skynet.wizard.session.v1";

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
