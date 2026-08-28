import { msg } from "@/shared/lib/messages";
import type { BlackboxHarness } from "@/shared/types/api";

// Mirrors BLACKBOX_HARNESSES on the backend, in the same order.
export const BLACKBOX_HARNESSES: readonly BlackboxHarness[] = [
  "pi",
  "codex",
  "claude_code",
  "opencode",
  "custom",
];

export function harnessLabel(harness: BlackboxHarness): string {
  return msg(`submit.blackbox.start.harness.${harness}`);
}
