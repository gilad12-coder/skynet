import { useSyncExternalStore } from "react";

/*
 * Per-tab memory of how a data-driven screen last rendered (how many rows,
 * cards, groups), so its next loading skeleton draws the same number of bones
 * and the page does not jump when the data lands. A cold first visit has no
 * hint and the skeleton falls back to its default. Kept in sessionStorage:
 * it survives a reload of the tab, and is gone with the tab.
 */

const STORAGE_PREFIX = "skynet-layout:";
const known = new Map<string, unknown>();

export function rememberLayout(key: string, value: unknown): void {
  const json = JSON.stringify(value);
  if (known.has(key) && JSON.stringify(known.get(key)) === json) return;
  known.set(key, value);
  try {
    window.sessionStorage.setItem(STORAGE_PREFIX + key, json);
  } catch {
    /* storage unavailable (private mode, quota) — the hint is in-memory only */
  }
}

export function layoutHint<T>(key: string | undefined): T | undefined {
  if (!key) return undefined;
  if (known.has(key)) return known.get(key) as T;
  try {
    const stored = window.sessionStorage.getItem(STORAGE_PREFIX + key);
    if (stored != null) {
      const value = JSON.parse(stored) as T;
      known.set(key, value);
      return value;
    }
  } catch {
    /* storage unavailable, rendering on the server, or an unreadable value */
  }
  return undefined;
}

// A skeleton reads its hint once per mount; nothing re-renders it when the
// loaded screen records a newer value, since the skeleton is gone by then.
const subscribeNever = () => () => {};

/** The remembered layout under `key`; undefined on the server so hydration matches. */
export function useLayoutHint<T>(key: string | undefined): T | undefined {
  return useSyncExternalStore(
    subscribeNever,
    () => layoutHint<T>(key),
    () => undefined,
  );
}

/**
 * A remembered count clamped to what one screen of the real list can show,
 * or `fallback` when nothing is remembered. A remembered 0 stays 0: the
 * screen's empty state has no rows either.
 */
export function hintedCount(hint: unknown, fallback: number, max = Infinity): number {
  return typeof hint === "number" && Number.isFinite(hint) && hint >= 0
    ? Math.min(Math.floor(hint), max)
    : fallback;
}

/** Tests only: forget every in-memory hint. */
export function resetLayoutHintsForTests(): void {
  known.clear();
}
