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

// Claude Code stays listed so users can see it, but it runs only as the
// proposer, on the user's own verified Anthropic key, where the deployment
// allows it; saved drafts and clones still open on the default harness.
export const UNAVAILABLE_HARNESSES: readonly BlackboxHarness[] = ["claude_code"];

export function harnessLabel(harness: BlackboxHarness): string {
  const key = `submit.blackbox.start.harness.${harness}` as const;
  const label = msg(key);
  // Stored jobs can name a harness that has since been retired; show its id
  // rather than the unresolved message key.
  return label === key ? harness : label;
}
