import { useSyncExternalStore } from "react";
import type { OptimizationType } from "@/shared/types/api";

/*
 * Remembers each run's kind once a fetch has seen it, so the next loading
 * skeleton for that run (a revisit, a reload in the same tab) can take the
 * shape of the page it is about to become instead of jumping on load.
 */

const STORAGE_PREFIX = "skynet-run-kind:";
const hints = new Map<string, OptimizationType>();

export function rememberRunKind(id: string, kind: OptimizationType): void {
  if (hints.get(id) === kind) return;
  hints.set(id, kind);
  try {
    window.sessionStorage.setItem(STORAGE_PREFIX + id, kind);
  } catch {
    /* storage unavailable (private mode, quota) — the hint is in-memory only */
  }
}

export function runKindHint(id: string | undefined): OptimizationType | undefined {
  if (!id) return undefined;
  const known = hints.get(id);
  if (known) return known;
  try {
    const stored = window.sessionStorage.getItem(STORAGE_PREFIX + id);
    if (stored) {
      hints.set(id, stored as OptimizationType);
      return stored as OptimizationType;
    }
  } catch {
    /* storage unavailable, or rendering on the server */
  }
  return undefined;
}

const subscribeNever = () => () => {};

/** The remembered kind of a run; undefined on the server so hydration matches. */
export function useRunKindHint(id: string | undefined): OptimizationType | undefined {
  return useSyncExternalStore(
    subscribeNever,
    () => runKindHint(id),
    () => undefined,
  );
}
