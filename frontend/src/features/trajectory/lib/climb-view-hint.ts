import { useSyncExternalStore } from "react";

/*
 * Remembers how each run's trajectory card rendered — the climb chart, the
 * candidate tree with or without its generation scrubber, or no card yet —
 * so the next loading skeleton for that run reserves the same height and the
 * page does not jump on load.
 */

/** "scrubber" / "plain" = the candidate tree with / without the generation scrubber. */
export type TrajectoryView = "climb" | "scrubber" | "plain" | "none";

const STORAGE_PREFIX = "skynet-climb-view:";
const VIEWS: readonly string[] = ["climb", "scrubber", "plain", "none"];
const known = new Map<string, TrajectoryView>();

export function rememberTrajectoryView(key: string, view: TrajectoryView): void {
  if (known.get(key) === view) return;
  known.set(key, view);
  try {
    window.sessionStorage.setItem(STORAGE_PREFIX + key, view);
  } catch {
    /* storage unavailable (private mode, quota) — the hint is in-memory only */
  }
}

export function trajectoryViewHint(key: string | undefined): TrajectoryView | undefined {
  if (!key) return undefined;
  const hit = known.get(key);
  if (hit) return hit;
  try {
    const stored = window.sessionStorage.getItem(STORAGE_PREFIX + key);
    // "1" is how the climb chart was remembered before the other views were.
    const view = stored === "1" ? "climb" : stored && VIEWS.includes(stored) ? stored : null;
    if (view) {
      known.set(key, view as TrajectoryView);
      return view as TrajectoryView;
    }
  } catch {
    /* storage unavailable, or rendering on the server */
  }
  return undefined;
}

const subscribeNever = () => () => {};

/** How this run's trajectory card last rendered; undefined on the server so hydration matches. */
export function useTrajectoryViewHint(key: string | undefined): TrajectoryView | undefined {
  return useSyncExternalStore(
    subscribeNever,
    () => trajectoryViewHint(key),
    () => undefined,
  );
}
