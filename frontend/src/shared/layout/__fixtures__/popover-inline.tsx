// Stands in for the popover primitive in account-menu.states.test.tsx. The real
// content renders in a portal, which a static render leaves empty; this renders
// it inline and keeps it, so a test can call a menu item's onClick.
import * as React from "react";

export const lastContentRef: { current: React.ReactNode } = { current: null };

export function Popover({ children }: { children?: React.ReactNode }) {
  return <>{children}</>;
}

export function PopoverTrigger({ children }: { children?: React.ReactNode }) {
  return <>{children}</>;
}

function keep(children: React.ReactNode): void {
  lastContentRef.current = children;
}

export function PopoverContent({ children }: { children?: React.ReactNode }) {
  keep(children);
  return <div data-testid="popover-content">{children}</div>;
}
