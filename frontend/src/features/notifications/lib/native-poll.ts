/*
 * The Mac app's notification polling rules, pure so they can be unit tested
 * without a browser or a server.
 */

import type { NativeNotification } from "@/shared/lib/api";

/** Run `fn` after `ms`; returns a cancel function. */
export type Schedule = (fn: () => void, ms: number) => () => void;

export const browserSchedule: Schedule = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

/**
 * Ask `probe` until it answers. Any answer ends the check, including null
 * (a hosted server's 404). An error (the API restarting, a timeout) tries
 * again after `retryMs`. Returns a cancel function.
 */
export function probeUntilAnswered<T>(
  probe: () => Promise<T>,
  onAnswer: (value: T) => void,
  retryMs: number,
  schedule: Schedule = browserSchedule,
): () => void {
  let live = true;
  let cancelTimer: (() => void) | null = null;
  const attempt = () => {
    cancelTimer = null;
    probe().then(
      (value) => {
        if (live) onAnswer(value);
      },
      () => {
        if (live) cancelTimer = schedule(attempt, retryMs);
      },
    );
  };
  attempt();
  return () => {
    live = false;
    cancelTimer?.();
  };
}

/** Show each claimed notification; returns the ids that were shown, to confirm. */
export function showClaimed(
  items: readonly NativeNotification[],
  show: (item: NativeNotification) => boolean,
): string[] {
  return items.filter((item) => show(item)).map((item) => item.id);
}
