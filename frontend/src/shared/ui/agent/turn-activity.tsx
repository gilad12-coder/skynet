"use client";

import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { CaretRight, WarningCircle } from "@/shared/ui/icons";

import { cn } from "@/shared/lib/utils";
import { getActiveIntlLocale } from "@/shared/lib/runtime-locale";
import { formatMsg } from "@/shared/lib/messages";
import type { ActivityKind } from "@/shared/lib/activity-summary";
import { interleaveThinking } from "@/shared/lib/thinking-segments";

import { ActivityGroup } from "./activity-steps";
import { ThinkingSection } from "./thinking-section";
import { earliestStart, finishedTurnMs, turnStart } from "./turn-timing";
import type { AgentThinking, AgentToolCall } from "./types";

/** One "Thinking" / "Thought for" row of a turn, placed by the tool calls before it. */
export type TurnThinking = AgentThinking & { toolsBefore: number };

interface TurnActivityProps {
  /** The turn's thinking segments, oldest first. */
  thinking: readonly TurnThinking[];
  /**
   * Each call with its index among the turn's tool calls. A ``card`` call
   * renders on its own at its place in the history and stays shown when the
   * history is folded; every other call is a one-line step.
   */
  steps: Array<{ call: AgentToolCall; isRetry: boolean; index: number; card?: boolean }>;
  /** The turn is still running. */
  streaming: boolean;
  renderStep: (call: AgentToolCall, ctx: { isRetry: boolean }) => React.ReactNode;
  /** What kind of step a call is, for the burst's summary line. */
  stepKind?: (call: AgentToolCall) => ActivityKind;
  /** Backend-measured turn duration; the history's own span wins when longer. */
  durationMs?: number | null;
  /**
   * The turn's start from every thinking segment, including ones that never
   * got reasoning and so show no row.
   */
  startedAt?: number | null;
}

// Mirrors Codex's turn header: while the agent works, a "Working for 14s"
// line over the turn's history so far: each stretch of thinking as its own
// row, with the tools that ran between them under one summary line each; once done, a "Worked for 39s" line over the same
// history, which stays open and folds away only when clicked. Cards the user
// acts on sit at their place in that history and stay shown when it folds.
export function TurnActivity({
  thinking,
  steps,
  streaming,
  renderStep,
  stepKind,
  durationMs,
  startedAt = null,
}: TurnActivityProps) {
  const reduce = Boolean(useReducedMotion());
  // The whole turn counts, not only a running step, so the history stays
  // open in the gaps between one tool finishing and the next starting.
  // A card can wait on the user long after the turn ended, so only steps count.
  // The coding tool's card keeps working after the turn, so it keeps the header live.
  const isLive =
    streaming ||
    steps.some(({ call, card }) => call.working || (!card && call.status === "running"));
  // Finished history stays open; the header still folds it on request.
  const [open, setOpen] = React.useState(true);
  const [nowTs, setNowTs] = React.useState(() => Date.now());
  const [mountedAt] = React.useState(() => Date.now());
  // One start for the whole turn, so the live timer only ever counts up.
  const [start, setStart] = React.useState<number | null>(() =>
    earliestStart(startedAt, turnStart(thinking, steps)),
  );
  const nextStart = earliestStart(start, earliestStart(startedAt, turnStart(thinking, steps)));
  if (nextStart !== start) setStart(nextStart);

  React.useEffect(() => {
    if (!isLive) return;
    const id = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isLive]);

  const failed = steps.some(({ call, card }) => !card && call.status === "error");
  const pieces = interleaveThinking(thinking, steps);
  const hasCards = pieces.some((piece) => piece.kind === "card");

  const renderPiece = (piece: (typeof pieces)[number]) =>
    piece.kind === "card" ? (
      <div key={`card-${piece.step.call.id}`} className="py-1.5">
        {renderStep(piece.step.call, { isRetry: piece.step.isRetry })}
      </div>
    ) : piece.kind === "thinking" ? (
      <ThinkingSection
        key={`thinking-${thinking.indexOf(piece.segment)}`}
        thinking={piece.segment}
        compact
      />
    ) : (
      <ActivityGroup
        key={`steps-${piece.steps[0]?.call.id}`}
        live={isLive}
        stayOpen
        steps={piece.steps.map(({ call }) => ({
          kind: stepKind?.(call) ?? "tool",
          status: call.status,
        }))}
      >
        {piece.steps.map(({ call, isRetry }) => (
          <React.Fragment key={call.id}>{renderStep(call, { isRetry })}</React.Fragment>
        ))}
      </ActivityGroup>
    );

  const history = <div className="flex flex-col">{pieces.map(renderPiece)}</div>;

  if (isLive) {
    return (
      <div className="flex flex-col">
        <Header
          label={formatMsg("shared.agent.working_for", {
            duration: formatSpan(nowTs - (start ?? mountedAt)),
          })}
          live
        />
        <div className="pt-1.5">{history}</div>
      </div>
    );
  }

  const elapsed = finishedTurnMs(start, thinking, steps, durationMs);
  return (
    <div className="flex flex-col">
      <Header
        label={formatMsg("shared.agent.worked_for", { duration: formatSpan(elapsed) })}
        open={open}
        failed={failed}
        onToggle={() => setOpen((v) => !v)}
      />
      {hasCards ? (
        // Folding keeps the cards mounted where they are, so one waiting on
        // the user (an upload, the coding tool) keeps its state.
        <div className="flex flex-col pt-1.5">
          {pieces.filter((piece) => open || piece.kind === "card").map(renderPiece)}
        </div>
      ) : (
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
      )}
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
