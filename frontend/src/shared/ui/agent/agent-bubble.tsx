"use client";

import * as React from "react";
import dynamic from "next/dynamic";

import { cn } from "@/shared/lib/utils";
import type { ActivityKind } from "@/shared/lib/activity-summary";

import { ThinkingSection } from "./thinking-section";
import { TurnActivity } from "./turn-activity";
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
  className?: string;
}

export function AgentBubble({
  msg,
  thinking,
  renderToolCall,
  isStepCall,
  stepKind,
  onRunCode,
  toolCallsBeforeContent = false,
  className,
}: AgentBubbleProps) {
  const visibleToolCalls = React.useMemo<Array<{ call: AgentToolCall; isRetry: boolean }>>(() => {
    const calls = msg.toolCalls;
    if (!calls?.length) return [];
    const result: Array<{ call: AgentToolCall; isRetry: boolean }> = [];
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
      result.push({ call, isRetry });
    }
    return result;
  }, [msg.toolCalls]);

  const stepCalls =
    renderToolCall && isStepCall ? visibleToolCalls.filter(({ call }) => isStepCall(call)) : [];
  const cardCalls = stepCalls.length
    ? visibleToolCalls.filter(({ call }) => !isStepCall?.(call))
    : visibleToolCalls;
  const hasTools = cardCalls.length > 0 && Boolean(renderToolCall);
  const hasText = msg.content.trim().length > 0;
  const hasThinking = Boolean(
    thinking && (thinking.reasoning || (thinking.streaming && thinking.startedAt)),
  );
  const hasActivity = hasThinking || stepCalls.length > 0;

  if (!hasTools && !hasText && !hasActivity) return null;

  const toolCalls = hasTools && renderToolCall && (
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
      {hasActivity && renderToolCall && isStepCall ? (
        <TurnActivity
          thinking={hasThinking ? thinking : undefined}
          steps={stepCalls}
          renderStep={renderToolCall}
          stepKind={stepKind}
          durationMs={msg.stats?.durationMs}
        />
      ) : (
        hasThinking && thinking && <ThinkingSection thinking={thinking} compact />
      )}
      {toolCallsBeforeContent && toolCalls}
      {hasText && (
        <div className="text-sm leading-relaxed text-foreground">
          <React.Suspense
            fallback={<span className="whitespace-pre-wrap">{msg.content}</span>}
          >
            <MessageMarkdown content={msg.content} onRunCode={onRunCode} />
          </React.Suspense>
        </div>
      )}
      {!toolCallsBeforeContent && toolCalls}
    </div>
  );
}
