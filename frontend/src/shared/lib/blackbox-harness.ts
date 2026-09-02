import { msg } from "@/shared/lib/messages";
import type { BlackboxHarness } from "@/shared/types/api";

// The backend's BLACKBOX_HARNESSES in the same order, minus "custom": the
// wizard only offers the built-in harnesses, though the API still accepts it.
export const BLACKBOX_HARNESSES: readonly BlackboxHarness[] = [
  "pi",
  "codex",
  "claude_code",
  "opencode",
];

export function harnessLabel(harness: BlackboxHarness): string {
  return msg(`submit.blackbox.start.harness.${harness}`);
}
