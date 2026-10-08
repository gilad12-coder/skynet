"use client";

import { MagicWand } from "@/shared/ui/icons";
import { msg } from "@/shared/lib/messages";
import { cn } from "@/shared/lib/utils";

/**
 * The one plain line Guided shows where it hid a step's settings, naming what
 * Skynet chose so the run is never a mystery. The level still changes only in
 * Settings, so the line's link opens the slider there instead of revealing the
 * settings in place: a hidden setting must never be one the user can't find.
 */
export function GuidedChoiceLine({
  text,
  onShowMore,
  className,
}: {
  text: string;
  onShowMore?: () => void;
  className?: string;
}) {
  return (
    <p
      className={cn("flex items-start gap-2 text-xs text-muted-foreground", className)}
      data-testid="guided-choice-line"
    >
      <MagicWand className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0">
        {text}
        {onShowMore && (
          <>
            {" "}
            <button
              type="button"
              onClick={onShowMore}
              className="relative rounded-sm font-medium text-foreground underline after:absolute after:-inset-3 after:content-[''] decoration-border underline-offset-2 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C8A882]/45"
            >
              {msg("experience.guided.change_level")}
            </button>
          </>
        )}
      </span>
    </p>
  );
}
