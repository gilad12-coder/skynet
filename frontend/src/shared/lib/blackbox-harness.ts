import { msg } from "@/shared/lib/messages";
import type { BlackboxHarness } from "@/shared/types/api";

// The backend's BLACKBOX_HARNESSES in the same order, minus "custom": the
// wizard only offers the built-in harnesses, though the API still accepts it.
export const BLACKBOX_HARNESSES: readonly BlackboxHarness[] = [
  "pi",
  "codex",
  "claude_code",
  "opencode",
  "prime",
];

// Claude Code stays listed so users can see it, but the backend refuses it
// until it can run on the user's own Anthropic key.
export const UNAVAILABLE_HARNESSES: readonly BlackboxHarness[] = ["claude_code"];

export function harnessLabel(harness: BlackboxHarness): string {
  return msg(`submit.blackbox.start.harness.${harness}`);
}
