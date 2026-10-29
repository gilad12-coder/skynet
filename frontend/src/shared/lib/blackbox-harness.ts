import { msg } from "@/shared/lib/messages";
import type { BlackboxHarness } from "@/shared/types/api";

// The backend's BLACKBOX_HARNESSES in the same order, minus "custom": the
// wizard only offers the built-in harnesses, though the API still accepts it.
export const BLACKBOX_HARNESSES: readonly BlackboxHarness[] = [
  "pi",
  "codex",
  "opencode",
  "prime",
];

// Stored runs may name a harness Skynet no longer offers (claude_code); those
// show their raw id instead of a catalog label.
export function harnessLabel(harness: string): string {
  return harness === "custom" || BLACKBOX_HARNESSES.includes(harness as BlackboxHarness)
    ? msg(`submit.blackbox.start.harness.${harness as BlackboxHarness}`)
    : harness;
}
