"use client";

import * as React from "react";
import { Warning } from "@/shared/ui/icons";
import { RetryIconButton } from "@/shared/ui/retry-icon-button";
import { cn } from "@/shared/lib/utils";

interface TurnFailedBlockProps {
  message: string;
  /** Why the turn failed, shown under the message when known. */
  detail?: string | null;
  retryLabel: string;
  onRetry: () => void;
  /** Extra content under the message, e.g. a "switch to manual" fallback link. */
  action?: React.ReactNode;
  className?: string;
}

// Sits in the thread where the failed reply would have been: a quiet note
// that the turn didn't finish, with a retry that reruns the same turn.
export function TurnFailedBlock({
  message,
  detail,
  retryLabel,
  onRetry,
  action,
  className,
}: TurnFailedBlockProps) {
  return (
    <div
      role="alert"
      className={cn("rounded-2xl border border-border/60 bg-card/70 px-4 py-3", className)}
    >
      <div className="flex items-start gap-2.5">
        <Warning className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-1 pt-px">
          <p className="text-xs leading-[1.45] text-foreground" dir="auto">
            {message}
          </p>
          {detail && (
            <p
              className="max-h-24 overflow-y-auto break-words text-[0.6875rem] leading-[1.45] text-muted-foreground"
              dir="auto"
            >
              {detail}
            </p>
          )}
          {action}
        </div>
        <RetryIconButton
          label={retryLabel}
          onClick={onRetry}
          className="size-[44px] shrink-0 shadow-none md:size-7 [@media(hover:none)_and_(pointer:coarse)]:size-[44px]"
        />
      </div>
    </div>
  );
}
