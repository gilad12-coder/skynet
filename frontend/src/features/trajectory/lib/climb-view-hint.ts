import { useSyncExternalStore } from "react";

/*
 * Remembers which runs drew the climb chart rather than the trajectory tree,
 * so the next loading skeleton for that run reserves the climb's height
 * instead of the tree's taller canvas and the page does not jump on load.
 */

const STORAGE_PREFIX = "skynet-climb-view:";
const known = new Set<string>();

export function rememberClimbView(id: string): void {
  if (known.has(id)) return;
  known.add(id);
  try {
    window.sessionStorage.setItem(STORAGE_PREFIX + id, "1");
  } catch {
    /* storage unavailable (private mode, quota) — the hint is in-memory only */
  }
}

function climbViewHint(id: string | undefined): boolean {
  if (!id) return false;
  if (known.has(id)) return true;
  try {
    if (window.sessionStorage.getItem(STORAGE_PREFIX + id) === "1") {
      known.add(id);
      return true;
    }
  } catch {
    /* storage unavailable */
  }
  return false;
}

const subscribeNever = () => () => {};

/** Whether this run is known to draw the climb chart; false on the server so hydration matches. */
export function useClimbViewHint(id: string | undefined): boolean {
  return useSyncExternalStore(
    subscribeNever,
    () => climbViewHint(id),
    () => false,
  );
}
