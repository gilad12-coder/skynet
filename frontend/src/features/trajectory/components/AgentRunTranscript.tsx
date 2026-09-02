"use client";

import {
  ArrowDown,
  Brain,
  CaretRight,
  ChatText,
  Check,
  CheckCircle,
  DotsThree,
  FileText,
  Package,
  PencilSimple,
  PencilSimpleLine,
  Play,
  Robot,
  Terminal,
  UserCircle,
  Wrench,
} from "@/shared/ui/icons";
import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { formatMsg, msg, type MessageKey } from "@/shared/lib/messages";
import { cn } from "@/shared/lib/utils";
import { MessageMarkdown } from "@/shared/ui/agent/message-markdown";
import { CopyButton } from "@/shared/ui/copy-button";
import { PingDot } from "@/shared/ui/ping-dot";
import {
  parseTranscript,
  type NoticeBlock,
  type StepBlock,
  type ToolPart,
  type TranscriptBlock,
  type TranscriptStep,
  type TurnBlock,
} from "../lib/transcript";

// Within this distance of the end the reader is following along, so new
// output keeps them at the end; further up they are reading and it must not.
const STICK_PX = 48;
// Long outputs fold past this many lines; a couple of extra lines are not worth a fold.
const CLIP_LINES = 12;
const CLIP_SLACK = 2;
const PROMPT_LINES = 6;
const THINKING_LINES = 40;

type Icon = ComponentType<{ className?: string }>;

const STEP_LABELS: Record<TranscriptStep, MessageKey> = {
  install: "agent_run.transcript.step.install",
  setup: "agent_run.transcript.step.setup",
  run: "agent_run.transcript.step.run",
  check: "agent_run.transcript.step.check",
};

const STEP_ICONS: Record<TranscriptStep, Icon> = {
  install: Package,
  setup: Wrench,
  run: Play,
  check: CheckCircle,
};

const TOOL_ICONS: Record<string, Icon> = {
  bash: Terminal,
  read: FileText,
  write: PencilSimpleLine,
  edit: PencilSimple,
};

const NOTICE_LABELS: Record<NoticeBlock["note"], MessageKey> = {
  cut: "agent_run.transcript.cut",
  capped: "agent_run.transcript.capped",
};

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--blue)]/35";
const CARET_CLASS =
  "size-2.5 shrink-0 text-muted-foreground transition-transform duration-[var(--duration-fast)] ease-[var(--ease-snappy)] rtl:-scale-x-100";

function compactCount(n: number): string {
  if (n < 1000) return n.toLocaleString();
  const thousands = n / 1000;
  return `${thousands >= 100 ? Math.round(thousands) : thousands.toFixed(1).replace(/\.0$/, "")}k`;
}

function lineCount(text: string): number {
  return text.replace(/\s+$/, "").split("\n").length;
}

/** The blinking end-of-text mark of something still being written. */
function Cursor() {
  return (
    <span
      aria-hidden="true"
      className="ms-0.5 inline-block h-[1.1em] w-0.5 translate-y-[0.2em] rounded-sm bg-[var(--warning)] motion-safe:animate-pulse"
    />
  );
}

function Marker({
  icon: Glyph,
  filled,
  pulse,
  className,
}: {
  icon: Icon;
  filled?: boolean;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "absolute -start-7 top-0 flex size-5 items-center justify-center rounded-full border",
        filled
          ? "border-foreground/80 bg-foreground/80 text-background"
          : "border-border bg-background text-muted-foreground",
        pulse && "motion-safe:animate-pulse",
        className,
      )}
    >
      <Glyph className="size-2.5" />
    </span>
  );
}

function EntryHeader({ label, meta }: { label: string; meta?: string | null }) {
  return (
    <div className="flex h-5 items-center gap-2">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      {meta ? (
        <span className="font-mono text-[10px] tabular-nums text-[var(--text-3)]">{meta}</span>
      ) : null}
    </div>
  );
}

/** Content that slides open and shut; it stays mounted so its own state survives a fold. */
function Disclosure({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div
      className="grid transition-[grid-template-rows] duration-[var(--duration-base)] ease-[var(--ease-snappy)] motion-reduce:transition-none"
      style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
    >
      <div className="min-h-0 overflow-hidden" inert={!open}>
        {children}
      </div>
    </div>
  );
}

function DiffLine({ line }: { line: string }) {
  const added = line.startsWith("+");
  const removed = line.startsWith("-");
  return (
    <span
      className={cn(
        "-mx-2.5 block px-2.5",
        added && "bg-[var(--success)]/8 text-[var(--success)]",
        removed && "bg-[var(--danger-dim)] text-[var(--danger)]",
      )}
    >
      {line}
    </span>
  );
}

/** Text that folds past a line budget, with a toggle to unfold. Running tools show their tail. */
function FoldedText({
  text,
  lines = CLIP_LINES,
  tail = false,
  diff = false,
  writing = false,
  className,
  dir = "ltr",
}: {
  text: string;
  lines?: number;
  tail?: boolean;
  diff?: boolean;
  writing?: boolean;
  className?: string;
  dir?: "ltr" | "auto";
}) {
  const [open, setOpen] = useState(false);
  const all = text.replace(/\s+$/, "").split("\n");
  const hidden = all.length - lines;
  const folds = hidden > CLIP_SLACK;
  const shown = folds && !open ? (tail ? all.slice(-lines) : all.slice(0, lines)) : all;
  return (
    <div>
      <pre
        className={cn("whitespace-pre-wrap", className)}
        dir={dir}
        style={{ wordBreak: "break-word" }}
      >
        {diff ? shown.map((line, index) => <DiffLine key={index} line={line} />) : shown.join("\n")}
        {writing ? <Cursor /> : null}
      </pre>
      {folds ? (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className={cn(
            "mt-1 inline-flex h-6 items-center rounded px-1.5 text-[10px] font-semibold text-[var(--blue)] transition-colors duration-[var(--duration-fast)] hover:bg-accent",
            FOCUS_RING,
          )}
        >
          {open
            ? msg("agent_run.transcript.show_less")
            : formatMsg("agent_run.transcript.show_more", { n: hidden })}
        </button>
      ) : null}
    </div>
  );
}

/** A runner phase. It sticks to the top while its output scrolls by, so the reader knows where they are. */
function StepEntry({ block, live }: { block: StepBlock; live: boolean }) {
  const running = block.exitCode === null;
  const failed = !running && (block.exitCode !== 0 || block.timedOut);
  return (
    <li className="sticky top-0 z-[1] -ms-11 bg-background ps-11">
      <Marker icon={STEP_ICONS[block.step]} filled className="start-4" />
      <div className="flex h-5 items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-foreground/85">
          {msg(STEP_LABELS[block.step])}
        </span>
        {running ? (
          live ? (
            <PingDot className="scale-75" />
          ) : null
        ) : (
          <span
            className={cn(
              "font-mono text-[10px] tabular-nums",
              failed ? "text-[var(--danger)]" : "text-[var(--success)]",
            )}
          >
            {block.timedOut
              ? msg("agent_run.transcript.step_timed_out")
              : formatMsg("agent_run.transcript.step_exit", { code: block.exitCode ?? 0 })}
          </span>
        )}
        <span className="h-px flex-1 bg-border/60" aria-hidden="true" />
      </div>
    </li>
  );
}

function NoticeEntry({ block }: { block: NoticeBlock }) {
  return (
    <li className="relative">
      <Marker icon={DotsThree} />
      <p className="flex min-h-5 items-center text-[11px] italic leading-[1.4] text-muted-foreground">
        {msg(NOTICE_LABELS[block.note])}
      </p>
    </li>
  );
}

function RawEntry({ text }: { text: string }) {
  return (
    <li className="relative">
      <Marker icon={Terminal} />
      <FoldedText
        text={text}
        className="rounded-md bg-secondary/50 px-3 py-2 font-mono text-[11px] leading-[1.5] text-[var(--text-2)]"
      />
    </li>
  );
}

function PromptEntry({ text }: { text: string }) {
  return (
    <li className="relative">
      <Marker icon={UserCircle} />
      <EntryHeader label={msg("agent_run.transcript.prompt")} />
      <FoldedText
        text={text}
        lines={PROMPT_LINES}
        dir="auto"
        className="mt-1 max-w-[68ch] font-sans text-[12px] leading-[1.55] text-foreground/90"
      />
    </li>
  );
}

function ThinkingEntry({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(streaming);
  const preview = text.trimStart().split("\n", 1)[0] ?? "";
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "group flex h-6 w-full min-w-0 items-center gap-1.5 rounded px-1 text-start transition-colors duration-[var(--duration-fast)] hover:bg-accent",
          FOCUS_RING,
        )}
      >
        <CaretRight
          className={cn(CARET_CLASS, open && "rotate-90 rtl:rotate-90")}
          aria-hidden="true"
        />
        <Brain className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {msg("agent_run.transcript.thinking")}
        </span>
        {!open && preview.length > 0 ? (
          <span className="min-w-0 truncate text-[11px] text-[var(--text-3)]" dir="auto">
            {preview}
          </span>
        ) : null}
        {!open && streaming ? <Cursor /> : null}
      </button>
      <Disclosure open={open}>
        <FoldedText
          text={text}
          lines={THINKING_LINES}
          tail={streaming}
          writing={streaming}
          dir="auto"
          className="mt-1 max-w-[68ch] rounded-md bg-secondary/40 px-3 py-2 font-sans text-[11.5px] leading-[1.55] text-[var(--text-2)]"
        />
      </Disclosure>
    </div>
  );
}

function ReplyEntry({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <div>
      <div className="flex h-5 items-center gap-1.5">
        <ChatText className="size-3 text-muted-foreground" aria-hidden="true" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {msg("agent_run.transcript.reply")}
        </span>
        {streaming ? <Cursor /> : null}
      </div>
      <MessageMarkdown
        content={text}
        className="mt-0.5 max-w-[68ch] text-[12px] leading-[1.55] text-foreground/90"
      />
    </div>
  );
}

interface ToolFace {
  /** What the header says after the tool's name: the path it touched or the command it ran. */
  headline: string | null;
  /** What the tool was given, when the headline does not already show it all. */
  body: string | null;
  /** The body is a before/after pair of an edit. */
  diff: boolean;
  /** What the copy button hands over. */
  copyText: string | null;
}

function describeTool(tool: ToolPart): ToolFace {
  const { args } = tool;
  const command = typeof args.command === "string" ? args.command : null;
  if (command !== null) {
    const [first = "", ...rest] = command.split("\n");
    return {
      headline: first,
      body: rest.length > 0 ? command : null,
      diff: false,
      copyText: command,
    };
  }
  const path = typeof args.path === "string" ? args.path : null;
  const oldText = typeof args.oldText === "string" ? args.oldText : null;
  const newText = typeof args.newText === "string" ? args.newText : null;
  if (oldText !== null || newText !== null) {
    const removed = (oldText ?? "").split("\n").map((line) => `- ${line}`);
    const added = (newText ?? "").split("\n").map((line) => `+ ${line}`);
    return {
      headline: path,
      body: [...removed, ...added].join("\n"),
      diff: true,
      copyText: newText,
    };
  }
  const content = typeof args.content === "string" ? args.content : null;
  if (content !== null) return { headline: path, body: content, diff: false, copyText: content };
  const rest = Object.entries(args).filter(([key]) => key !== "path");
  const body = rest.length > 0 ? JSON.stringify(Object.fromEntries(rest), null, 2) : null;
  return { headline: path, body, diff: false, copyText: body };
}

function ToolEntry({ tool, live }: { tool: ToolPart; live: boolean }) {
  const { headline, body, diff, copyText } = describeTool(tool);
  const [open, setOpen] = useState(true);
  const running = !tool.done && live;
  const failed = tool.done && tool.isError;
  const Glyph = TOOL_ICONS[tool.name] ?? Wrench;
  const result = tool.result !== null && tool.result.trim().length > 0 ? tool.result : null;
  const bodyLines = body === null ? 0 : lineCount(body);
  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border",
        failed ? "border-[var(--danger-border)]" : "border-border/60",
      )}
    >
      <div
        className={cn(
          "flex h-7 items-center gap-1.5 pe-1 ps-1.5 text-[10px]",
          failed ? "bg-[var(--danger-dim)]" : "bg-secondary/60",
        )}
      >
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className={cn(
            "flex h-full min-w-0 flex-1 items-center gap-1.5 rounded text-start",
            FOCUS_RING,
          )}
        >
          <CaretRight
            className={cn(CARET_CLASS, open && "rotate-90 rtl:rotate-90")}
            aria-hidden="true"
          />
          <Glyph className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="shrink-0 font-mono font-medium text-foreground/85">{tool.name}</span>
          {headline ? (
            <span className="min-w-0 truncate font-mono text-muted-foreground" dir="ltr">
              {headline}
            </span>
          ) : null}
        </button>
        {bodyLines > CLIP_LINES ? (
          <span className="shrink-0 font-mono tabular-nums text-[var(--text-3)]">
            {formatMsg("agent_run.transcript.lines", { n: bodyLines })}
          </span>
        ) : null}
        {running ? (
          <span className="inline-flex shrink-0 items-center gap-1.5 text-muted-foreground">
            <PingDot className="scale-75" />
            {msg("agent_run.transcript.tool_running")}
          </span>
        ) : failed ? (
          <span className="shrink-0 font-semibold text-[var(--danger)]">
            {msg("agent_run.transcript.tool_failed")}
          </span>
        ) : tool.done ? (
          <span className="inline-flex shrink-0 items-center text-[var(--success)]">
            <Check className="size-3" aria-hidden="true" />
            <span className="sr-only">{msg("agent_run.transcript.tool_done")}</span>
          </span>
        ) : null}
        {copyText !== null && copyText.length > 0 ? (
          <CopyButton
            text={copyText}
            ariaLabel={msg("agent_run.transcript.copy_input")}
            copiedAriaLabel={msg("agent_run.transcript.copied")}
            className="size-6 text-muted-foreground"
            iconClassName="size-3"
          />
        ) : null}
      </div>
      <Disclosure open={open}>
        {body !== null ? (
          <FoldedText
            text={body}
            diff={diff}
            className="px-2.5 py-2 font-mono text-[11px] leading-[1.5] text-foreground/90"
          />
        ) : null}
        {result !== null ? (
          <div
            className={cn(
              "bg-background",
              body !== null && "border-t",
              failed ? "border-[var(--danger-border)]" : "border-border/50",
            )}
          >
            <FoldedText
              text={result}
              tail={running}
              writing={running}
              className={cn(
                "px-2.5 py-2 font-mono text-[11px] leading-[1.5]",
                failed ? "text-[var(--danger)]" : "text-[var(--text-2)]",
              )}
            />
          </div>
        ) : null}
      </Disclosure>
    </div>
  );
}

function TurnEntry({ block, live }: { block: TurnBlock; live: boolean }) {
  const streaming = block.pending && live;
  const lastIndex = block.parts.length - 1;
  return (
    <li className="relative">
      <Marker icon={Robot} pulse={streaming} />
      <EntryHeader
        label={formatMsg("agent_run.transcript.turn", { n: block.index })}
        meta={
          block.tokens !== null
            ? formatMsg("agent_run.transcript.tokens", { n: compactCount(block.tokens) })
            : null
        }
      />
      <div className="mt-1 space-y-2">
        {block.parts.map((part, index) => {
          const partStreaming = streaming && index === lastIndex;
          if (part.kind === "thinking")
            return <ThinkingEntry key={index} text={part.text} streaming={partStreaming} />;
          if (part.kind === "text")
            return <ReplyEntry key={index} text={part.text} streaming={partStreaming} />;
          return <ToolEntry key={index} tool={part} live={live} />;
        })}
      </div>
    </li>
  );
}

function Entry({ block, live }: { block: TranscriptBlock; live: boolean }) {
  switch (block.kind) {
    case "step":
      return <StepEntry block={block} live={live} />;
    case "notice":
      return <NoticeEntry block={block} />;
    case "raw":
      return <RawEntry text={block.text} />;
    case "prompt":
      return <PromptEntry text={block.text} />;
    case "turn":
      return <TurnEntry block={block} live={live} />;
  }
}

interface Tally {
  turns: number;
  tools: number;
  failed: number;
  /** Every entry and part, so the jump pill can say how much arrived unseen. */
  units: number;
}

function tally(blocks: TranscriptBlock[]): Tally {
  const total: Tally = { turns: 0, tools: 0, failed: 0, units: 0 };
  for (const block of blocks) {
    if (block.kind !== "turn") {
      total.units += 1;
      continue;
    }
    total.turns += 1;
    total.units += block.parts.length;
    for (const part of block.parts) {
      if (part.kind !== "tool") continue;
      total.tools += 1;
      if (part.done && part.isError) total.failed += 1;
    }
  }
  return total;
}

function summaryOf(count: Tally): string | null {
  if (count.turns === 0) return null;
  const parts = [
    formatMsg("agent_run.transcript.summary_turns", { n: count.turns }),
    formatMsg("agent_run.transcript.summary_tools", { n: count.tools }),
  ];
  if (count.failed > 0)
    parts.push(formatMsg("agent_run.transcript.summary_failed", { n: count.failed }));
  return parts.join(" · ");
}

export function AgentRunTranscript({ transcript, live }: { transcript: string; live: boolean }) {
  const [stuck, setStuck] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // How much had arrived when the reader scrolled away; the jump pill counts from there.
  const [seen, setSeen] = useState(0);
  const blocks = useMemo(() => parseTranscript(transcript, live), [transcript, live]);
  const count = useMemo(() => tally(blocks), [blocks]);
  const summary = summaryOf(count);

  useEffect(() => {
    const el = scrollRef.current;
    if (el === null || !stuck) return;
    el.scrollTop = el.scrollHeight;
  }, [transcript, stuck]);

  const fresh = stuck ? 0 : Math.max(0, count.units - seen);

  const jump = () => {
    const el = scrollRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
    setStuck(true);
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex h-7 items-center gap-2">
        {live ? (
          <span className="inline-flex shrink-0 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <PingDot className="scale-75" />
            {msg("agent_run.transcript.live")}
          </span>
        ) : null}
        {summary !== null ? (
          <span className="min-w-0 truncate font-mono text-[10px] tabular-nums text-[var(--text-3)]">
            {summary}
          </span>
        ) : null}
        <span className="flex-1" aria-hidden="true" />
        {transcript.length > 0 ? (
          <CopyButton
            text={transcript}
            ariaLabel={msg("agent_run.transcript.copy")}
            copiedAriaLabel={msg("agent_run.transcript.copied")}
            title={msg("agent_run.transcript.copy")}
            className="text-muted-foreground"
          />
        ) : null}
      </div>
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            const near = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
            if (stuck && !near) setSeen(count.units);
            setStuck(near);
          }}
          className="h-full overflow-y-auto rounded-lg border border-border/50 bg-background"
        >
          {transcript.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center">
              <Terminal className="size-5 text-[var(--text-3)]" aria-hidden="true" />
              <p className="text-[11px] text-muted-foreground">
                {msg(live ? "agent_run.transcript.waiting" : "agent_run.transcript.empty")}
              </p>
            </div>
          ) : (
            <ol
              className={cn(
                "relative m-0 list-none space-y-4 px-4 py-4 ps-11 before:absolute before:inset-y-5 before:start-[25.5px] before:w-px before:bg-border/70",
                live && "pb-12",
              )}
            >
              {blocks.map((block, index) => (
                <Entry key={index} block={block} live={live} />
              ))}
            </ol>
          )}
        </div>
        {live && !stuck && transcript.length > 0 ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
            <button
              type="button"
              onClick={jump}
              className={cn(
                "pointer-events-auto inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-card px-3 text-[10px] font-semibold text-foreground shadow-sm transition-colors duration-[var(--duration-fast)] hover:bg-accent",
                FOCUS_RING,
              )}
            >
              <ArrowDown className="size-3" aria-hidden="true" />
              {msg("agent_run.transcript.jump")}
              {fresh > 0 ? (
                <span className="font-mono tabular-nums text-muted-foreground">
                  · {formatMsg("agent_run.transcript.jump_new", { n: fresh })}
                </span>
              ) : null}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
