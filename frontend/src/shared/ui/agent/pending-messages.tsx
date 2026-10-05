"use client";

import * as React from "react";
import { CircleNotch, Clock, PaperPlaneTilt, PencilSimple, X } from "@/shared/ui/icons";
import { msg } from "@/shared/lib/messages";
import { TooltipButton } from "@/shared/ui/tooltip-button";
import { cn } from "@/shared/lib/utils";

import type { PendingMessage } from "./steer-queue";

interface PendingMessagesProps {
  queued: readonly PendingMessage[];
  steering: readonly PendingMessage[];
  /** Queued follow-ups can be moved into the running turn right now. */
  canPromote: boolean;
  onPromote: (id: string) => void;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
}

function RowAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <TooltipButton tooltip={label} side="top">
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        className={cn(
          "inline-flex size-6 shrink-0 items-center justify-center rounded-md",
          "text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground",
        )}
      >
        {children}
      </button>
    </TooltipButton>
  );
}

/**
 * Messages sent while the agent was still working, listed above the composer:
 * steers the agent will read at its next step, then follow-ups queued to run
 * as their own turns once it is done.
 */
export function PendingMessages({
  queued,
  steering,
  canPromote,
  onPromote,
  onEdit,
  onRemove,
}: PendingMessagesProps) {
  if (queued.length === 0 && steering.length === 0) return null;
  return (
    <ul className="mb-2 flex flex-col gap-1" aria-label={msg("agent.pending.list_label")}>
      {steering.map((item) => (
        <li
          key={item.id}
          className="flex items-start gap-2 rounded-lg border border-border/40 bg-muted/30 px-2.5 py-1.5"
        >
          <CircleNotch className="mt-0.5 size-3.5 shrink-0 animate-spin text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 whitespace-pre-wrap break-words text-xs leading-snug">
              {item.text}
            </p>
            <p className="text-[11px] leading-snug text-muted-foreground">
              {msg("agent.pending.steering")}
            </p>
          </div>
        </li>
      ))}
      {queued.map((item) => (
        <li
          key={item.id}
          className="flex items-start gap-2 rounded-lg border border-border/40 bg-muted/20 px-2.5 py-1.5"
        >
          <Clock className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <p className="line-clamp-2 min-w-0 flex-1 whitespace-pre-wrap break-words text-xs leading-snug">
            {item.text}
          </p>
          <div className="flex shrink-0 items-center gap-0.5">
            {canPromote && (
              <RowAction label={msg("agent.pending.steer")} onClick={() => onPromote(item.id)}>
                <PaperPlaneTilt className="size-3.5 rtl:-scale-x-100" />
              </RowAction>
            )}
            <RowAction label={msg("agent.pending.edit")} onClick={() => onEdit(item.id)}>
              <PencilSimple className="size-3.5" />
            </RowAction>
            <RowAction label={msg("agent.pending.remove")} onClick={() => onRemove(item.id)}>
              <X className="size-3.5" />
            </RowAction>
          </div>
        </li>
      ))}
    </ul>
  );
}
