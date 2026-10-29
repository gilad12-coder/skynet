"use client";

import * as React from "react";

/** How long a filled screen stays on view before the wizard moves past it. */
export const AUTO_ADVANCE_MS = 900;

/** Lets a step's agent move the wizard past a screen it just completed. */
export interface WizardAutoAdvance {
  /**
   * Continue past `screen` once it is on view and Continue is open. A
   * request for a screen that is not on view, or that the user leaves
   * first, is dropped.
   */
  advanceFrom: (screen: string) => void;
}

const NOOP: WizardAutoAdvance = { advanceFrom: () => undefined };

export const WizardAutoAdvanceContext = React.createContext<WizardAutoAdvance>(NOOP);

export function useWizardAutoAdvance(): WizardAutoAdvance {
  return React.useContext(WizardAutoAdvanceContext);
}

/**
 * The frame side: holds one pending request and runs the frame's own
 * Continue for it after a short pause, so the user sees what was filled.
 *
 * @param visibleScreen The screen on view.
 * @param open Whether Continue is open on it.
 * @param forward The Continue button's handler.
 * @param heldScreen A screen that never moves on by itself until the user
 *   leaves it: the one a reload reopened, whose filled state was not
 *   just completed.
 */
export function useAutoAdvanceDriver(
  visibleScreen: string,
  open: boolean,
  forward: () => void,
  heldScreen: string | null = null,
): WizardAutoAdvance {
  const [pending, setPending] = React.useState<string | null>(null);
  const forwardRef = React.useRef(forward);
  React.useEffect(() => {
    forwardRef.current = forward;
  });
  const heldRef = React.useRef(heldScreen);
  React.useEffect(() => {
    if (visibleScreen !== heldRef.current) heldRef.current = null;
  }, [visibleScreen]);

  React.useEffect(() => {
    if (pending === null) return;
    if (pending !== visibleScreen || pending === heldRef.current) {
      setPending(null);
      return;
    }
    if (!open) return;
    const timer = setTimeout(() => {
      setPending(null);
      forwardRef.current();
    }, AUTO_ADVANCE_MS);
    return () => clearTimeout(timer);
  }, [pending, visibleScreen, open]);

  return React.useMemo(() => ({ advanceFrom: (screen: string) => setPending(screen) }), []);
}
