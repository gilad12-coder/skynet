"use client";

import { Button } from "@/shared/ui/primitives/button";

export type DraftRestoreState = "offer" | "working" | "failed";

/**
 * The body of the restore offer: a question, the draft's whereabouts, and the
 * two choices D06 names. It never closes on its own — the container options
 * that open it turn off auto-close, click-to-dismiss and dragging — so the
 * buttons are the only way out, and both are real buttons for the keyboard.
 */
export function DraftRestoreToast({
  title,
  meta,
  state,
  failureText,
  continueLabel,
  retryLabel,
  startNewLabel,
  onContinue,
  onStartNew,
}: {
  title: string;
  meta: string | null;
  state: DraftRestoreState;
  failureText: string | null;
  continueLabel: string;
  retryLabel: string;
  startNewLabel: string;
  onContinue: () => void;
  onStartNew: () => void;
}) {
  const working = state === "working";
  return (
    <div className="flex min-w-0 flex-col gap-3" data-tutorial="submit-draft-offer">
      <div className="min-w-0">
        <p className="font-semibold text-foreground">{title}</p>
        {state === "failed" && failureText ? (
          <p className="mt-1 text-xs text-destructive">{failureText}</p>
        ) : (
          meta && <p className="mt-0.5 text-xs text-muted-foreground">{meta}</p>
        )}
      </div>
      <div className="grid w-full grid-cols-2 gap-2">
        <Button
          size="sm"
          className="w-full justify-center"
          onClick={onContinue}
          disabled={working}
          aria-busy={working || undefined}
          data-tutorial="submit-draft-continue"
        >
          {state === "failed" ? retryLabel : continueLabel}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="w-full justify-center"
          onClick={onStartNew}
          disabled={working}
          data-tutorial="submit-draft-start-new"
        >
          {startNewLabel}
        </Button>
      </div>
    </div>
  );
}
