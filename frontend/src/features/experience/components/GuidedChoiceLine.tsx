"use client";

import { MagicWand } from "@/shared/ui/icons";
import { cn } from "@/shared/lib/utils";

/**
 * The one plain line Guided shows where it hid a step's settings, naming what
 * Skynet chose so the run is never a mystery. There is deliberately no "show"
 * link: the level changes only in Settings.
 */
export function GuidedChoiceLine({ text, className }: { text: string; className?: string }) {
  return (
    <p
      className={cn("flex items-start gap-2 text-xs text-muted-foreground", className)}
      data-testid="guided-choice-line"
    >
      <MagicWand className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0">{text}</span>
    </p>
  );
}
