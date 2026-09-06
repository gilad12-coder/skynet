"use client";

import { CircleNotch } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";

export type DraftRestoreState = "offer" | "working" | "failed";

/**
 * The restore question and two equal-width choices. The fixed width keeps
 * failure text and the working spinner from resizing the toast under the
 * cursor. It stays open until the user chooses an action.
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
    <div className="flex w-96 min-w-0 max-w-full flex-col gap-3" data-tutorial="submit-draft-offer">
      <p className="text-center text-[14px] font-semibold leading-5 text-foreground">{title}</p>
      {failed && failureText && (
        <p role="alert" className="text-pretty text-[14px] leading-relaxed text-destructive">
          {failureText}
        </p>
      )}
      <div className="grid w-full grid-cols-2 gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-auto min-h-[44px]! min-w-0 py-2 text-[14px] whitespace-normal text-center"
          onClick={onStartNew}
          disabled={working}
          data-tutorial="submit-draft-start-new"
        >
          {startNewLabel}
        </Button>
        <Button
          size="sm"
          className="h-auto min-h-[44px]! min-w-0 py-2 text-[14px] whitespace-normal text-center"
          onClick={onContinue}
          disabled={working}
          aria-busy={working || undefined}
          data-tutorial="submit-draft-continue"
        >
          {working && (
            <CircleNotch className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
          )}
          {failed ? retryLabel : continueLabel}
        </Button>
      </div>
    </div>
  );
}
