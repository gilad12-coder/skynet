"use client";

import * as React from "react";
import {
  DEFAULT_WIDTH,
  MAX_WIDTH,
  MIN_WIDTH,
  STORAGE_KEY_OPEN,
  STORAGE_KEY_WIDTH,
} from "../constants";

interface PanelState {
  open: boolean;
  setOpen: (v: boolean) => void;
  toggle: () => void;
  width: number;
  setWidth: (v: number) => void;
  /** Element the minimized pill portals into while a surface has docked it. */
  pillDock: HTMLElement | null;
  /** Dock the pill into ``el``; returns the undo for the caller's unmount. */
  registerPillDock: (el: HTMLElement) => () => void;
  /** True while a surface that brings its own agent hides the launcher. */
  pillHidden: boolean;
  /** Hide the minimized pill; returns the undo for the caller's unmount. */
  hidePill: () => () => void;
}

const PanelContext = React.createContext<PanelState | null>(null);

function clampWidth(n: number): number {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(n)));
}

/**
 * Provides the generalist panel's persistent UI state (open/closed,
 * width).
 *
 * Mounted once in the app shell so the panel's thread survives route
 * changes. Hydrates from ``localStorage`` on the client only to avoid
 * SSR mismatches.
 */
export function GeneralistPanelProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpenState] = React.useState(false);
  const [width, setWidthState] = React.useState(DEFAULT_WIDTH);

  React.useEffect(() => {
    try {
      setOpenState(window.localStorage.getItem(STORAGE_KEY_OPEN) === "true");
      const raw = window.localStorage.getItem(STORAGE_KEY_WIDTH);
      const n = raw ? Number(raw) : NaN;
      if (Number.isFinite(n)) setWidthState(clampWidth(n));
    } catch {
      /* localStorage unavailable */
    }
  }, []);

  const setOpen = React.useCallback((next: boolean) => {
    setOpenState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY_OPEN, String(next));
    } catch {
      /* noop */
    }
  }, []);

  const toggle = React.useCallback(() => {
    setOpenState((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(STORAGE_KEY_OPEN, String(next));
      } catch {
        /* noop */
      }
      return next;
    });
  }, []);

  const setWidth = React.useCallback((next: number) => {
    const clamped = clampWidth(next);
    setWidthState(clamped);
    try {
      window.localStorage.setItem(STORAGE_KEY_WIDTH, String(clamped));
    } catch {
      /* noop */
    }
  }, []);

  // Full-bleed working surfaces whose bottom bar owns the viewport corner
  // (the tagger walkthroughs' Prev/Next row) re-home the floating pill by
  // registering a dock. Last registration wins; the undo only clears its own
  // element, so an unmount racing a sibling's mount stays consistent.
  const [pillDock, setPillDock] = React.useState<HTMLElement | null>(null);
  const registerPillDock = React.useCallback((el: HTMLElement) => {
    setPillDock(el);
    return () => setPillDock((prev) => (prev === el ? null : prev));
  }, []);

  // A count, not a flag, so one surface unmounting can't unhide the pill
  // while another that also hides it is still mounted.
  const [pillHiders, setPillHiders] = React.useState(0);
  const hidePill = React.useCallback(() => {
    setPillHiders((n) => n + 1);
    return () => setPillHiders((n) => n - 1);
  }, []);
  const pillHidden = pillHiders > 0;

  const value = React.useMemo<PanelState>(
    () => ({
      open,
      setOpen,
      toggle,
      width,
      setWidth,
      pillDock,
      registerPillDock,
      pillHidden,
      hidePill,
    }),
    [open, setOpen, toggle, width, setWidth, pillDock, registerPillDock, pillHidden, hidePill],
  );

  return <PanelContext.Provider value={value}>{children}</PanelContext.Provider>;
}

export function useGeneralistPanelState(): PanelState {
  const ctx = React.useContext(PanelContext);
  if (!ctx) {
    throw new Error("useGeneralistPanelState must be used within GeneralistPanelProvider");
  }
  return ctx;
}

/**
 * Like {@link useGeneralistPanelState}, but null when the agent feature is
 * disabled (the provider isn't mounted then). For chrome that merely adapts
 * to the agent — e.g. the pill dock — rather than requiring it.
 */
export function useGeneralistPanelStateOptional(): PanelState | null {
  return React.useContext(PanelContext);
}

/**
 * Hides the agent launcher pill while the caller is mounted, for surfaces
 * that carry their own agent (the submit wizard's Auto mode) so the app-wide
 * launcher would only be a second door to the same help. A no-op when the
 * agent feature is disabled.
 */
export function useHideAgentPill(): void {
  const hide = useGeneralistPanelStateOptional()?.hidePill;
  React.useEffect(() => hide?.(), [hide]);
}
