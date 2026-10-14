"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowsClockwise, CaretRight, Warning, type Icon } from "@/shared/ui/icons";
import { msg } from "@/shared/lib/messages";
import { CopyButton } from "@/shared/ui/copy-button";
import { looksLikeMarkdown } from "@/shared/lib/markdown-hint";

import { cn } from "@/shared/lib/utils";
import type { AgentToolCall } from "@/shared/ui/agent/types";

import { isPlainObject } from "../lib/entry-format";
import { getToolMeta, getToolTitle } from "../lib/tool-meta";

import { EntryRow } from "./EntryRow";

// The feature barrel (and with it this row) sits in the app shell's static
// graph, so the markdown parser loads only once a result is opened.
const MessageMarkdown = dynamic(
  () => import("@/shared/ui/agent/message-markdown").then((m) => m.MessageMarkdown),
  { ssr: false },
);

interface ToolCallRowProps {
  call: AgentToolCall;
  isRetry?: boolean;
  /** Hebrew one-liner that replaces ``call.reason`` in the collapsed trigger. */
  summary?: string | null;
  /** Override for the trigger title. Defaults to ``TOOL_META.title``. */
  title?: string | null;
  /** Override for the status-glyph icon (done state). Defaults to ``TOOL_META.icon``. */
  icon?: Icon;
  /**
   * Replaces the default args/result body. Caller renders whatever fits the
   * tool — e.g. a diff view. Wrapped in the same container as the default
   * body so vertical rhythm stays identical to the generalist tools.
   */
  customBody?: React.ReactNode;
}

/**
 * One tool invocation rendered as a quiet one-line step, as in Codex: the
 * tool's icon and title in muted text, the running step shimmering, and a
 * chevron that appears on hover. Args and result open in a framed box below
 * the line; only errors open on their own. A per-tool summary string
 * (provided by the renderer registry) replaces the raw LLM reason in the
 * collapsed line with a domain-specific Hebrew one-liner.
 */
export function ToolCallRow({
  call,
  isRetry = false,
  summary,
  title,
  icon,
  customBody,
}: ToolCallRowProps) {
  const meta = getToolMeta(call.tool);
  const derivedTitle = title ?? getToolTitle(call.tool);
  const Icon = icon ?? meta.icon;

  const [open, setOpen] = React.useState(call.status === "error");

  React.useEffect(() => {
    if (call.status === "error") setOpen(true);
  }, [call.status]);

  const payload = (call.payload ?? {}) as Record<string, unknown>;
  const args = isPlainObject(payload.arguments) ? payload.arguments : {};
  const result = payload.result;
  const argEntries = Object.entries(args);
  const hasArgs = argEntries.length > 0;
  const hasResult = result !== undefined && result !== null && result !== "";

  const triggerText = summary ?? call.reason ?? null;
  const isError = call.status === "error";
  const showReasonInBody = call.reason && call.reason !== triggerText;

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cn(
          "group flex w-full min-w-0 items-center gap-2 py-1 text-start text-[0.8125rem]",
          "cursor-pointer transition-colors",
          isError
            ? "text-[#7A1E13] dark:text-[#ffb2a0]"
            : open
              ? "text-foreground"
              : "text-muted-foreground hover:text-foreground",
        )}
      >
        {isError ? (
          <Warning
            className="size-3.5 shrink-0"
            aria-label={msg("auto.features.agent.panel.components.toolcallrow.literal.7")}
          />
        ) : (
          <Icon className="size-3.5 shrink-0" aria-hidden />
        )}
        <span
          className={cn("shrink-0 truncate", call.status === "running" && "agent-shimmer-text")}
        >
          {derivedTitle}
        </span>
        {triggerText && (
          <span className="min-w-0 truncate opacity-70" title={triggerText}>
            {triggerText}
          </span>
        )}
        {isRetry && (
          <ArrowsClockwise
            className="size-3 shrink-0 opacity-60"
            aria-label={msg("auto.features.agent.panel.components.toolcallrow.literal.2")}
          />
        )}
        <CaretRight
          className={cn(
            "size-3 shrink-0 transition-[transform,opacity] duration-150",
            open ? "rotate-90" : "rtl:-scale-x-100 opacity-0 group-hover:opacity-100",
          )}
          aria-hidden="true"
        />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
            className="overflow-hidden"
          >
            <div
              className={cn(
                "mb-2 mt-1 overflow-hidden rounded-lg border",
                isError
                  ? "border-[#9B2C1F]/20 dark:border-[#ec7764]/20"
                  : "border-border/60 bg-muted/30",
              )}
            >
              <div className="border-b border-border/50 px-3 py-1.5 text-xs text-muted-foreground">
                {derivedTitle}
              </div>
              <div className="space-y-2.5 px-3 py-2.5">
                {showReasonInBody && (
                  <div className="text-[0.75rem] leading-snug text-muted-foreground/85">
                    {call.reason}
                  </div>
                )}
                {customBody !== undefined ? (
                  customBody
                ) : (
                  <>
                    {hasArgs && (
                      <Section
                        label={msg("auto.features.agent.panel.components.toolcallrow.literal.3")}
                      >
                        <dl className="space-y-1.5">
                          {argEntries.map(([k, v]) => (
                            <EntryRow key={k} argKey={k} value={v} />
                          ))}
                        </dl>
                      </Section>
                    )}
                    {hasResult && (
                      <Section
                        label={
                          isError
                            ? msg("auto.features.agent.panel.components.toolcallrow.literal.4")
                            : msg("auto.features.agent.panel.components.toolcallrow.literal.5")
                        }
                      >
                        <ResultBody result={result} isError={isError} />
                      </Section>
                    )}
                    {!hasArgs && !hasResult && call.status === "running" && (
                      <div className="text-[0.75rem] italic text-muted-foreground/75 leading-snug">
                        {msg("auto.features.agent.panel.components.toolcallrow.2")}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[0.6875rem]/[1.55] font-medium text-muted-foreground/70">
        {label}
      </div>
      {children}
    </div>
  );
}

function ResultBody({ result, isError }: { result: unknown; isError: boolean }) {
  if (typeof result === "string") {
    const trimmed = result.trim();
    if (!trimmed) {
      return <EmptyPlaceholder />;
    }
    if (!isError && looksLikeMarkdown(trimmed)) {
      return (
        <div className="max-h-52 overflow-y-auto rounded-md border border-border/40 bg-background/70 px-2.5 py-2 text-[0.75rem] leading-relaxed text-foreground/90">
          <MessageMarkdown content={trimmed} />
        </div>
      );
    }
    return (
      <div className="relative" dir="ltr">
        <pre
          className={cn(
            "whitespace-pre-wrap break-words font-mono text-[0.6875rem]/[1.55] max-h-52 overflow-y-auto rounded-md border p-2 pe-9",
            isError
              ? "border-[#9B2C1F]/20 dark:border-[#ec7764]/20 bg-[#FCEFEB]/60 dark:bg-[#463833]/60 text-[#7A1E13] dark:text-[#ffb2a0]"
              : "border-border/40 bg-background/70 text-foreground/90",
          )}
        >
          {trimmed}
        </pre>
        <CopyButton
          text={trimmed}
          ariaLabel={msg("auto.features.agent.panel.components.toolcallrow.literal.10")}
          copiedAriaLabel={msg("auto.features.agent.panel.components.toolcallrow.literal.9")}
          stopPropagation
          className="absolute end-1.5 top-1.5"
        />
      </div>
    );
  }

  if (isPlainObject(result)) {
    const entries = Object.entries(result);
    if (entries.length === 0) {
      return <EmptyPlaceholder />;
    }
    return (
      <dl className="space-y-1.5">
        {entries.map(([k, v]) => (
          <EntryRow key={k} argKey={k} value={v} />
        ))}
      </dl>
    );
  }

  if (Array.isArray(result)) {
    if (result.length === 0) {
      return <EmptyPlaceholder />;
    }
    return (
      <dl className="space-y-1.5">
        {result.slice(0, 20).map((item, idx) => (
          <EntryRow key={idx} argKey={`${idx + 1}`} value={item} />
        ))}
        {result.length > 20 && (
          <div className="text-[0.625rem] italic text-muted-foreground/60">
            {msg("auto.features.agent.panel.components.toolcallrow.3")}
            {result.length - 20}…
          </div>
        )}
      </dl>
    );
  }

  return (
    <div className="font-mono text-[0.6875rem]/[1.55] text-foreground/90" dir="ltr">
      {String(result)}
    </div>
  );
}

function EmptyPlaceholder() {
  return <div className="text-[0.6875rem]/[1.55] text-muted-foreground/60">—</div>;
}
