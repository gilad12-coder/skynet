"use client";

import type { ReactNode } from "react";

import { cn } from "@/shared/lib/utils";

/**
 * One screen of a wizard step. Inactive screens stay mounted but hidden, so
 * moving between them keeps editor undo history and half-typed fields. The
 * body fills the step and only overflows on its own on very short viewports.
 */
export function WizardScreen({
  active,
  className,
  children,
}: {
  active: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      hidden={!active}
      className={cn(
        "min-h-0 flex-1 overflow-y-auto animate-in fade-in duration-200 motion-reduce:animate-none",
        className,
      )}
    >
      {children}
    </div>
  );
}
