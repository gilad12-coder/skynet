import type { MessageKey } from "@/shared/lib/generated/ui-catalog";

const RUNTIME_LABEL_KEYS: Record<string, MessageKey> = {
  vercel: "submit.runtime.vercel",
  docker: "submit.runtime.docker",
};

/** The translated label key for an execution runtime id, or null for an id with no label yet. */
export function runtimeLabelKey(runtime: string): MessageKey | null {
  return RUNTIME_LABEL_KEYS[runtime] ?? null;
}
