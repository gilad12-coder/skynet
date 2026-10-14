"use client";

import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { CaretRight, WarningCircle } from "@/shared/ui/icons";

import { cn } from "@/shared/lib/utils";
import { getActiveIntlLocale } from "@/shared/lib/runtime-locale";
import { formatMsg } from "@/shared/lib/messages";
import type { ActivityKind } from "@/shared/lib/activity-summary";

import { ActivityGroup } from "./activity-steps";
import { ThinkingSection } from "./thinking-section";
import type { AgentThinking, AgentToolCall } from "./types";

interface TurnActivityProps {
  thinking?: AgentThinking;
  steps: Array<{ call: AgentToolCall; isRetry: boolean }>;
  renderStep: (call: AgentToolCall, ctx: { isRetry: boolean }) => React.ReactNode;
  /** What kind of step a call is, for the burst's summary line. */
  stepKind?: (call: AgentToolCall) => ActivityKind;
  /** Backend-measured turn duration, preferred over the client clock. */
  durationMs?: number | null;
}

// Mirrors Codex's turn header: while the agent works, a "Working for 14s"
// line over the turn's history so far, the thinking row and then its tools
// under one summary line; once done, a "Worked for 39s" line over the same
// history, which stays open and folds away only when clicked.
export function TurnActivity({
  thinking,
  steps,
  renderStep,
  stepKind,
  durationMs,
}: TurnActivityProps) {
  const reduce = Boolean(useReducedMotion());
  const isThinking = Boolean(thinking?.streaming && !thinking.endedAt && thinking.startedAt);
  const running = steps.filter(({ call }) => call.status === "running");
  // The whole turn counts, not only a running step, so the history stays
  // open in the gaps between one tool finishing and the next starting.
  const isLive = isThinking || running.length > 0 || Boolean(thinking?.streaming);
  // Finished history stays open; the header still folds it on request.
  const [open, setOpen] = React.useState(true);
  const [nowTs, setNowTs] = React.useState(() => Date.now());

  React.useEffect(() => {
    if (!isLive) return;
    const id = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isLive]);

  const start = turnStart(thinking, steps);
  const failed = steps.some(({ call }) => call.status === "error");

  const history = (
    <div className="flex flex-col">
      {thinking && <ThinkingSection thinking={thinking} compact />}
      {steps.length > 0 && (
        <ActivityGroup
          live={isLive}
          steps={steps.map(({ call }) => ({
            kind: stepKind?.(call) ?? "tool",
            status: call.status,
          }))}
        >
          {steps.map(({ call, isRetry }) => (
            <React.Fragment key={call.id}>{renderStep(call, { isRetry })}</React.Fragment>
          ))}
        </ActivityGroup>
      )}
    </div>
  );

  if (isLive) {
    return (
      <div className="flex flex-col">
        <Header
          label={formatMsg("shared.agent.working_for", {
            duration: formatSpan(start ? nowTs - start : 0),
          })}
          live
        />
        <div className="pt-1.5">{history}</div>
      </div>
    );
  }

  const elapsed = durationMs ?? turnSpanMs(thinking, steps);
  return (
    <div className="flex flex-col">
      <Header
        label={formatMsg("shared.agent.worked_for", { duration: formatSpan(elapsed) })}
        open={open}
        failed={failed}
        onToggle={() => setOpen((v) => !v)}
      />
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduce ? undefined : { height: 0, opacity: 0 }}
            transition={reduce ? { duration: 0 } : { duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
            className="overflow-hidden"
          >
            <div className="max-h-72 overflow-y-auto pt-1.5">{history}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Header({
  label,
  live = false,
  open = false,
  failed = false,
  onToggle,
}: {
  label: string;
  live?: boolean;
  open?: boolean;
  failed?: boolean;
  onToggle?: () => void;
}) {
  const content = (
    <>
      {failed && <WarningCircle className="size-3.5 shrink-0 text-[#7A1E13] dark:text-[#ffb2a0]" />}
      <span className={cn("truncate", live && "agent-shimmer-text")}>{label}</span>
      {onToggle && (
        <CaretRight
          className={cn(
            "size-3 shrink-0 transition-transform duration-150",
            open ? "rotate-90" : "rtl:-scale-x-100",
          )}
          aria-hidden
        />
      )}
    </>
  );
  const className =
    "flex w-full items-center gap-1.5 border-b border-border/60 pb-2 text-start text-[0.8125rem] text-muted-foreground";
  if (!onToggle) return <div className={className}>{content}</div>;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className={cn(className, "cursor-pointer transition-colors hover:text-foreground")}
    >
      {content}
    </button>
  );
}

function turnStart(
  thinking: AgentThinking | undefined,
  steps: Array<{ call: AgentToolCall }>,
): number | null {
  const starts = steps.map(({ call }) => call.startedAt).filter(Boolean);
  if (thinking?.startedAt) starts.push(thinking.startedAt);
  return starts.length ? Math.min(...starts) : null;
}

function turnSpanMs(
  thinking: AgentThinking | undefined,
  steps: Array<{ call: AgentToolCall }>,
): number {
  const start = turnStart(thinking, steps);
  if (start === null) return 0;
  const ends = steps.map(({ call }) => call.endedAt ?? call.startedAt);
  if (thinking?.endedAt) ends.push(thinking.endedAt);
  return Math.max(0, Math.max(start, ...ends) - start);
}

function formatSpan(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000));
  const unit = (value: number, u: "minute" | "second") =>
    new Intl.NumberFormat(getActiveIntlLocale(), {
      style: "unit",
      unit: u,
      unitDisplay: "narrow",
    }).format(value);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  if (!mins) return unit(secs, "second");
  return secs ? `${unit(mins, "minute")} ${unit(secs, "second")}` : unit(mins, "minute");
}
