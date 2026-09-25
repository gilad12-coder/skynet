"use client";
import * as React from "react";
import { ArrowsIn, ArrowsOut } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/primitives/tooltip";
import { msg } from "@/shared/lib/messages";

/** The grow/shrink toggle for tables, dialogs and drawers that can fill the screen. */
export function ExpandToggleButton({
  ref,
  expanded,
  controls,
  onToggle,
  className,
}: {
  ref?: React.Ref<HTMLButtonElement>;
  expanded: boolean;
  /** Id of the element that grows. */
  controls?: string;
  onToggle: () => void;
  className?: string;
}) {
  const label = msg(
    expanded ? "shared.expandable_textarea.collapse" : "shared.expandable_textarea.expand",
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          ref={ref}
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          aria-expanded={expanded}
          aria-controls={controls}
          onClick={onToggle}
          className={className}
        >
          {expanded ? (
            <ArrowsIn className="size-[1.05rem] text-primary" aria-hidden="true" />
          ) : (
            <ArrowsOut className="size-[1.05rem] text-primary" aria-hidden="true" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Places the toggle just inside a sheet's close button, centered on it at both
 * close-button sizes (44px below ``lg``, 26px at ``lg``). Hidden on phones,
 * where sheets already fill the screen.
 */
export const SHEET_EXPAND_TOGGLE_CLASS =
  "absolute top-3.5 end-14 z-10 hidden sm:inline-flex lg:top-3 lg:end-12";

/** Width of an expanded side sheet, overriding its ``sm``/``md`` caps. */
export const SHEET_EXPANDED_CLASS = "sm:max-w-[96vw] md:max-w-[96vw]";
