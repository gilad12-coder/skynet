"use client";

import type { ReactNode } from "react";
import { getStatusLabel, STATUS_DOT_COLOR, STATUS_DOT_FALLBACK } from "@/shared/constants/job-status";
import { cn } from "@/shared/lib/utils";
import type { JobStatus } from "@/shared/types/api";

interface StatusBadgeProps {
  status: JobStatus | string;
  className?: string;
  /** Compact variant for table rows: smaller dot and text. */
  compact?: boolean;
}

export type StatusTone = "success" | "running" | "failed" | "pending" | "cancelled" | "paused";

/** A small solid status dot; running work gets a soft pulse halo. */
export function StatusDot({
  status,
  size = "md",
  className,
}: {
  status: JobStatus | StatusTone | string;
  size?: "sm" | "md";
  className?: string;
}) {
  const color = STATUS_DOT_COLOR[status] ?? STATUS_DOT_FALLBACK;
  const live = status === "running" || status === "validating";
  const sizeClass = size === "sm" ? "size-1.5" : "size-2";
  return (
    <span aria-hidden className={cn("relative inline-flex shrink-0", sizeClass, className)}>
      {live && (
        <span
          className="absolute inset-0 animate-ping rounded-full opacity-60 motion-reduce:animate-none"
          style={{ backgroundColor: color }}
        />
      )}
      <span className={cn("relative rounded-full", sizeClass)} style={{ backgroundColor: color }} />
    </span>
  );
}

/** A job status as a colored dot and a plain label, no filled pill. */
export function StatusBadge({ status, className = "", compact = false }: StatusBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex w-fit shrink-0 items-center gap-1.5 whitespace-nowrap",
        compact
          ? "text-xs font-medium text-muted-foreground"
          : "text-sm font-medium text-foreground",
        status === "failed" && "text-[var(--status-failed)]",
        className,
      )}
    >
      <StatusDot status={status} size={compact ? "sm" : "md"} />
      {getStatusLabel(status)}
    </span>
  );
}

/** Compact dot-and-label status for non-job statuses (keys, transactions). */
export function StatusPill({
  tone,
  className,
  children,
}: {
  tone: StatusTone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex w-fit shrink-0 items-center gap-1.5 whitespace-nowrap text-xs font-medium text-muted-foreground",
        tone === "failed" && "text-[var(--status-failed)]",
        className,
      )}
    >
      <StatusDot status={tone} size="sm" />
      {children}
    </span>
  );
}
