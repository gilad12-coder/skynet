"use client";

import type { ComponentProps, ReactNode } from "react";

import {
  ArrowCounterClockwise,
  ArrowRight,
  CircleNotch,
  ClockCounterClockwise,
  Plus,
  WarningCircle,
} from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/shared/ui/primitives/tooltip";

export type DraftRestoreState = "offer" | "working" | "failed";

/**
 * The body of the restore offer: a question and the two choices D06 names,
 * each an icon whose label is its tooltip and accessible name. It never
 * closes on its own, so the row is the only way out of the offer, and both
 * are real buttons for the keyboard. The width is fixed so a failure line
 * appearing, or a spinner entering the primary button, never resizes the
 * toast under the cursor.
 */
export function DraftRestoreToast({
  title,
  state,
  failureText,
  continueLabel,
  retryLabel,
  startNewLabel,
  onContinue,
  onStartNew,
}: {
  title: string;
  state: DraftRestoreState;
  failureText: string | null;
  continueLabel: string;
  retryLabel: string;
  startNewLabel: string;
  onContinue: () => void;
  onStartNew: () => void;
}) {
  const working = state === "working";
  const failed = state === "failed";

  return (
    <div className="flex w-72 max-w-full flex-col gap-3" data-tutorial="submit-draft-offer">
      <div className="flex items-start gap-2.5">
        {failed ? (
          <WarningCircle className="size-5 shrink-0 text-destructive" aria-hidden="true" />
        ) : (
          <ClockCounterClockwise
            className="size-5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-pretty font-semibold text-foreground">{title}</p>
          {failed && failureText && (
            <p className="mt-1 text-pretty text-xs leading-relaxed text-destructive">
              {failureText}
            </p>
          )}
        </div>
      </div>
      {/* Secondary before primary and end-aligned, as in the wizard's dialogs. */}
      <div className="flex justify-end gap-2">
        <IconAction
          label={startNewLabel}
          variant="outline"
          onClick={onStartNew}
          disabled={working}
          data-tutorial="submit-draft-start-new"
        >
          <Plus aria-hidden="true" />
        </IconAction>
        <IconAction
          label={failed ? retryLabel : continueLabel}
          onClick={onContinue}
          disabled={working}
          aria-busy={working || undefined}
          data-tutorial="submit-draft-continue"
        >
          {working ? (
            <CircleNotch className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
          ) : failed ? (
            <ArrowCounterClockwise aria-hidden="true" />
          ) : (
            <ArrowRight className="rtl:rotate-180" aria-hidden="true" />
          )}
        </IconAction>
      </div>
    </div>
  );
}

/**
 * An icon-only button whose label is both its tooltip and its accessible
 * name. The toast mounts outside the app's tooltip provider and on
 * react-toastify's layer above everything else, so the tooltip brings its
 * own provider and joins that layer, where its later place in the DOM paints
 * it over the toast instead of behind it.
 */
function IconAction({
  label,
  children,
  ...props
}: Omit<ComponentProps<typeof Button>, "aria-label" | "children" | "size"> & {
  label: string;
  children: ReactNode;
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="icon-sm" aria-label={label} {...props}>
            {children}
          </Button>
        </TooltipTrigger>
        <TooltipContent style={{ zIndex: "var(--toastify-z-index, 9999)" }}>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
