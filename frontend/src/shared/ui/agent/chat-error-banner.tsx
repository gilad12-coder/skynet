"use client";

import * as React from "react";
import { XCircle } from "@/shared/ui/icons";
import { RetryIconButton } from "@/shared/ui/retry-icon-button";
import { cn } from "@/shared/lib/utils";

interface ChatErrorBannerProps {
  message: React.ReactNode;
  retryLabel?: string;
  onRetry?: () => void;
  /** A compact action shown on the same row, after the message (e.g. "Add funds"). */
  action?: React.ReactNode;
  className?: string;
}

// Shared warm-toned error card for agent chat streams (auth/model/rate-limit
// failures). Mirrors the icon-badge + text + action layout established by
// SubmitSummaryCard/ApprovalCard so error state reads as a first-class card
// instead of a cramped inline row.
export function ChatErrorBanner({
  message,
  retryLabel,
  onRetry,
  action,
  className,
}: ChatErrorBannerProps) {
  return (
    <div
      role="alert"
      className={cn("rounded-2xl border border-[#9B2C1F]/20 dark:border-[#ec7764]/20 bg-[#FCEFEB]/60 dark:bg-[#463833]/60 p-3", className)}
    >
      <div className="flex items-center gap-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[#9B2C1F]/10 text-[#9B2C1F] dark:text-[#ffa595]">
          <XCircle className="size-3.5" aria-hidden="true" />
        </span>
        <p
          className="max-h-32 min-w-0 flex-1 overflow-y-auto break-words text-xs leading-[1.45] text-pretty text-[#7A1E13] dark:text-[#ffb2a0]"
          dir="auto"
        >
          {message}
        </p>
        {action && <div className="shrink-0">{action}</div>}
        {onRetry && retryLabel && (
          <RetryIconButton
            label={retryLabel}
            onClick={onRetry}
            className="size-[44px] shrink-0 border-[#9B2C1F]/25 dark:border-[#ec7764]/25 bg-transparent text-[#7A1E13] dark:text-[#ffb2a0] shadow-none hover:bg-[#9B2C1F]/10 hover:text-[#7A1E13] dark:hover:text-[#ffb2a0] md:size-7 [@media(hover:none)_and_(pointer:coarse)]:size-[44px]"
          />
        )}
      </div>
    </div>
  );
}
