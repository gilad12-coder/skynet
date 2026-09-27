"use client";

import * as React from "react";
import { registerTutorialHook } from "@/features/tutorial";

interface SettingsModalContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Tab to jump to on the next open, or null to keep the last/default tab. */
  targetTab: string | null;
  /** Open the modal focused on a specific tab (e.g. the credit chip → wallet). */
  openTo: (tab: string, focus?: string) => void;
  /** Consume the pending target tab so it doesn't re-apply on the next manual open. */
  clearTarget: () => void;
  /** Item inside the target tab to bring forward (e.g. one connector), or null. */
  targetFocus: string | null;
  /** Consume the pending focus once the tab has acted on it. */
  clearFocus: () => void;
}

const SettingsModalContext = React.createContext<SettingsModalContextValue | null>(null);

export function SettingsModalProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const [targetTab, setTargetTab] = React.useState<string | null>(null);
  const [targetFocus, setTargetFocus] = React.useState<string | null>(null);

  React.useEffect(() => {
    const url = new URL(window.location.href);
    const requestedTab = url.searchParams.get("settings");
    if (!requestedTab) return;
    setTargetTab(requestedTab);
    setOpen(true);
    url.searchParams.delete("settings");
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, []);

  const openTo = React.useCallback((tab: string, focus?: string) => {
    setTargetTab(tab);
    setTargetFocus(focus ?? null);
    setOpen(true);
  }, []);

  React.useEffect(
    () =>
      registerTutorialHook("setSettingsTab", (tab) => {
        if (tab === null) setOpen(false);
        else openTo(tab);
      }),
    [openTo],
  );

  const clearTarget = React.useCallback(() => setTargetTab(null), []);
  const clearFocus = React.useCallback(() => setTargetFocus(null), []);

  const value = React.useMemo(
    () => ({ open, setOpen, targetTab, openTo, clearTarget, targetFocus, clearFocus }),
    [open, targetTab, openTo, clearTarget, targetFocus, clearFocus],
  );
  return <SettingsModalContext.Provider value={value}>{children}</SettingsModalContext.Provider>;
}

export function useSettingsModal(): SettingsModalContextValue {
  const ctx = React.useContext(SettingsModalContext);
  if (!ctx) throw new Error("useSettingsModal must be used within SettingsModalProvider");
  return ctx;
}
