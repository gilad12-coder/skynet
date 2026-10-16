"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

import { cn } from "@/shared/lib/utils";
import type { ActivityKind } from "@/shared/lib/activity-summary";

import { RevealText } from "./reveal-text";
import { ThinkingSection } from "./thinking-section";
import { TurnActivity, type TurnThinking } from "./turn-activity";
import { turnStart, visibleThinking } from "./turn-timing";
import type { AgentMessage, AgentThinking, AgentToolCall } from "./types";

// react-markdown + remark-gfm (the micromark/mdast/hast tree, ~40-60 KB gzip)
// only matter once the agent chat actually renders a message, but the panel is
// mounted on every authenticated route. Lazy-load it so the parser stays out of
// the global first-load chunk; the Suspense fallback shows the raw text meanwhile.
const MessageMarkdown = dynamic(
  () => import("./message-markdown").then((m) => m.MessageMarkdown),
  { ssr: false },
);

interface AgentBubbleProps {
  msg: AgentMessage;
  thinking?: AgentThinking;
  /** This turn is still running; defaults to the live thinking's flag. */
  streaming?: boolean;
  renderToolCall?: (call: AgentToolCall, ctx: { isRetry: boolean }) => React.ReactNode;
  /**
   * Calls that render as plain one-line steps. They join the thinking row in
   * the turn's foldable activity group; every other call keeps its rich card.
   */
  isStepCall?: (call: AgentToolCall) => boolean;
  /** What kind of step a call is, for the summary line over the turn's steps. */
  stepKind?: (call: AgentToolCall) => ActivityKind;
  onRunCode?: (code: string, language: string) => void;
  toolCallsBeforeContent?: boolean;
  /**
   * Shown after the turn's text: the coding tool finishes after the reply was
   * written, so its closing outcome comes last, as in Codex.
   */
  afterContent?: React.ReactNode;
  className?: string;
}

export function AgentBubble({
  msg,
  thinking: liveThinking,
  streaming,
  renderToolCall,
  isStepCall,
  stepKind,
  onRunCode,
  toolCallsBeforeContent = false,
  afterContent,
  className,
}: AgentBubbleProps) {
  const reduce = useReducedMotion();
  // A plan there on mount belongs to a reopened chat and shows at once; one
  // that streams in opens its line smoothly and writes itself in.
  const [planOnMount] = React.useState(msg.plan);
  const visibleToolCalls = React.useMemo<
    Array<{ call: AgentToolCall; isRetry: boolean; index: number }>
  >(() => {
    const calls = msg.toolCalls;
    if (!calls?.length) return [];
    const result: Array<{ call: AgentToolCall; isRetry: boolean; index: number }> = [];
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      if (!call) continue;
      if (call.status === "error") {
        const superseded = calls
          .slice(i + 1)
          .some(
            (later) =>
              later.tool === call.tool && (later.status === "done" || later.status === "running"),
          );
        if (superseded) continue;
      }
      const isRetry = calls
        .slice(0, i)
        .some((prior) => prior.tool === call.tool && prior.status === "error");
      result.push({ call, isRetry, index: i });
    }
    return result;
  }, [msg.toolCalls]);

  const turnStreaming = streaming ?? Boolean(liveThinking?.streaming);
  // Segments saved on the message win: they stream live and outlast the
  // turn. Chats that only keep one live thinking state show it as one row.
  const allThinking = React.useMemo<TurnThinking[]>(
    () =>
      msg.thinkingSegments
        ? msg.thinkingSegments.map((s) => ({ ...s, streaming: turnStreaming }))
        : liveThinking
          ? [{ ...liveThinking, toolsBefore: 0 }]
          : [],
    [msg.thinkingSegments, liveThinking, turnStreaming],
  );
  // A segment with no reasoning yet is no row: it showed as "Thinking" for a
  // second and then vanished with the turn's header.
  const thinking = React.useMemo(() => visibleThinking(allThinking), [allThinking]);

  const stepCalls =
    renderToolCall && isStepCall ? visibleToolCalls.filter(({ call }) => isStepCall(call)) : [];
  const cardCalls = stepCalls.length
    ? visibleToolCalls.filter(({ call }) => !isStepCall?.(call))
    : visibleToolCalls;
  const hasTools = cardCalls.length > 0 && Boolean(renderToolCall);
  const hasText = msg.content.trim().length > 0;
  const hasThinking = thinking.length > 0;
  const withHistory = Boolean(renderToolCall && isStepCall);
  // With a history, a card call (the coding tool) is activity too; without
  // it, a turn whose only call is that card had no header, and the header
  // vanished once its reasoning-less thinking row dropped out.
  const hasActivity = hasThinking || (withHistory ? visibleToolCalls.length > 0 : stepCalls.length > 0);

  const plan = msg.plan?.trim();
  if (!hasTools && !hasText && !hasActivity && !plan) return null;

  // With a turn history, every call (cards too) sits in it in the order it
  // ran, so the whole turn reads top to bottom with the answer last, as in
  // Codex. ReActV2 takes back prose written before a tool (message_reset),
  // so the message's text is the turn's final answer.
  const inHistory = hasActivity && withHistory;
  const cardsFirst = toolCallsBeforeContent || Boolean(isStepCall);
  const toolCalls = hasTools && !inHistory && renderToolCall && (
    <div className="flex flex-col gap-1.5">
      {cardCalls.map(({ call, isRetry }) => (
        <React.Fragment key={call.id}>{renderToolCall(call, { isRetry })}</React.Fragment>
      ))}
    </div>
  );

  // No bubble around the agent's side, as in Codex: the turn header, the
  // cards and the answer sit straight on the panel at full width.
  return (
    <div className={cn("flex w-full min-w-0 flex-col gap-3", className)}>
      <AnimatePresence initial={false}>
        {plan && (
          <motion.div
            key="plan"
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            transition={{ duration: 0.25, ease: [0.2, 0.8, 0.2, 1] }}
            className="overflow-hidden"
          >
            <RevealText
              text={plan}
              animate={msg.plan !== planOnMount}
              className="block text-sm leading-relaxed text-foreground/80"
            />
          </motion.div>
        )}
      </AnimatePresence>
      {inHistory && renderToolCall ? (
        <TurnActivity
          thinking={thinking}
          steps={visibleToolCalls.map((v) => ({ ...v, card: !isStepCall?.(v.call) }))}
          streaming={turnStreaming}
          renderStep={renderToolCall}
          stepKind={stepKind}
          durationMs={msg.stats?.durationMs}
          startedAt={turnStart(allThinking, [])}
        />
      ) : (
        thinking.map((t, i) => <ThinkingSection key={i} thinking={t} compact />)
      )}
      {cardsFirst && toolCalls}
      {hasText && (
        <div className="text-sm leading-relaxed text-foreground">
          <React.Suspense
            fallback={<span className="whitespace-pre-wrap">{msg.content}</span>}
          >
            <MessageMarkdown content={msg.content} onRunCode={onRunCode} />
          </React.Suspense>
        </div>
      )}
      {!cardsFirst && toolCalls}
      {afterContent}
    </div>
  );
}
