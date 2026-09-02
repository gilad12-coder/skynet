"use client";

import dynamic from "next/dynamic";
import { useMemo, useState, type KeyboardEvent } from "react";
import { motion } from "framer-motion";
import { Code, Cube, DownloadSimple, Eye, GitDiff, Warning } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/primitives/select";
import { CopyButton } from "@/shared/ui/copy-button";
import { FadeIn } from "@/shared/ui/motion";
import { HelpTip } from "@/shared/ui/help-tip";
import { Skeleton } from "@/shared/ui/skeleton";
import type { BlackboxRunResult } from "@/shared/types/api";
import { formatMsg, msg } from "@/shared/lib/messages";
import { tip } from "@/shared/lib/tooltips";
import { getActiveDir } from "@/shared/lib/runtime-locale";
import { arrowPageStep, isEditableTarget } from "@/shared/lib/arrow-paging";
import { cn } from "@/shared/lib/utils";
import { CandidatePreview } from "./CandidatePreview";
import { VersionRail } from "./VersionRail";
import { formatBlackboxScore } from "@/shared/lib";
import { countChanges, diffRows } from "../lib/blackbox-diff";
import {
  buildVersions,
  defaultVersionIndex,
  type CandidateVersion,
} from "../lib/blackbox-versions";
import {
  detectRenderKind,
  formatJson,
  RENDER_KIND_EXTENSION,
  RENDER_KIND_LABEL,
  sideInfoImages,
  type RenderKind,
  isDrawable,
} from "@/shared/lib/candidate-render";

const CodeEditor = dynamic(() => import("@/shared/ui/code-editor").then((m) => m.CodeEditor), {
  ssr: false,
  loading: () => <Skeleton height={180} borderRadius={8} />,
});

// Same tints the trajectory drawer uses for accepted / rejected edits, so a
// diff reads the same everywhere in the run view.
const ADDED_BG = "rgba(138, 154, 91, 0.28)";
const ADDED_EMPHASIS_BG = "rgba(138, 154, 91, 0.55)";
const ADDED_FG = "#3f4d1f";
const REMOVED_BG = "rgba(168, 90, 59, 0.22)";
const REMOVED_EMPHASIS_BG = "rgba(168, 90, 59, 0.45)";
const REMOVED_FG = "#6e2e16";

type View = "preview" | "code" | "diff";

const VIEW_ICON = { preview: Eye, code: Code, diff: GitDiff } as const;

function editorHeight(text: string): string {
  return `${Math.min(560, Math.max(160, text.split("\n").length * 22 + 48))}px`;
}

function LineNumbered({ text }: { text: string }) {
  return (
    <div
      className="max-h-[32rem] overflow-auto rounded-lg border border-border/50 bg-muted/30 py-2 font-mono text-[0.8125rem] leading-relaxed"
      dir="ltr"
    >
      {text.split("\n").map((line, i) => (
        <div key={i} className="flex px-3">
          <span
            className="w-8 shrink-0 select-none pe-3 text-end tabular-nums text-muted-foreground/60"
            aria-hidden="true"
          >
            {i + 1}
          </span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{line || " "}</span>
        </div>
      ))}
    </div>
  );
}

function CodePart({ text, kind }: { text: string; kind: RenderKind }) {
  if (kind === "python") {
    return <CodeEditor value={text} onChange={() => {}} height={editorHeight(text)} readOnly />;
  }
  return <LineNumbered text={kind === "json" ? formatJson(text) : text} />;
}

function CodeView({ version, kind }: { version: CandidateVersion; kind: RenderKind }) {
  if (typeof version.candidate === "string") {
    return <CodePart text={version.candidate} kind={kind} />;
  }
  return (
    <div className="space-y-3">
      {Object.entries(version.candidate).map(([key, value]) => (
        <div key={key}>
          <p className="mb-1 font-mono text-xs font-semibold text-muted-foreground">{key}</p>
          <CodePart text={value} kind={detectRenderKind(value)} />
        </div>
      ))}
    </div>
  );
}

function DiffBlock({ before, after }: { before: string; after: string }) {
  const rows = useMemo(() => diffRows(before, after), [before, after]);
  const { added, removed } = countChanges(rows);
  if (added === 0 && removed === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {msg("optimization.blackbox.best.diff_identical")}
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-[0.6875rem] font-medium tabular-nums text-muted-foreground">
        {formatMsg("optimization.blackbox.best.diff_legend", { added, removed })}
      </p>
      <div
        className="max-h-[32rem] overflow-auto rounded-lg border border-border/50 bg-muted/30 py-2 font-mono text-[0.8125rem] leading-relaxed"
        dir="ltr"
      >
        {rows.map((row, i) => {
          const style =
            row.kind === "added"
              ? { background: ADDED_BG, color: ADDED_FG }
              : row.kind === "removed"
                ? { background: REMOVED_BG, color: REMOVED_FG }
                : undefined;
          const marker = row.kind === "added" ? "+" : row.kind === "removed" ? "−" : " ";
          return (
            <div key={i} className="flex min-h-[1.5em] px-3" style={style}>
              <span className="w-4 shrink-0 select-none opacity-70" aria-hidden="true">
                {marker}
              </span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
                {row.segments.map((seg, j) =>
                  seg.changed ? (
                    <mark
                      key={j}
                      className="rounded-sm text-inherit"
                      style={{
                        background: row.kind === "added" ? ADDED_EMPHASIS_BG : REMOVED_EMPHASIS_BG,
                      }}
                    >
                      {seg.text}
                    </mark>
                  ) : (
                    <span key={j}>{seg.text}</span>
                  ),
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ChangesView({ versions, index }: { versions: CandidateVersion[]; index: number }) {
  // Default to the version right before this one — the edit that produced it.
  const [base, setBase] = useState(index > 0 ? index - 1 : Math.min(1, versions.length - 1));
  if (versions.length < 2) {
    return (
      <p className="text-sm text-muted-foreground">
        {msg("optimization.blackbox.best.diff_identical")}
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{msg("optimization.blackbox.versions.compare_with")}</span>
        <Select value={String(base)} onValueChange={(value) => setBase(Number(value))}>
          <SelectTrigger
            className="h-7 w-auto min-w-[9rem] text-xs"
            aria-label={msg("optimization.blackbox.versions.compare_with")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {versions
              .filter((_, i) => i !== index)
              .map((version) => (
                <SelectItem key={version.number} value={String(version.number)} className="text-xs">
                  {formatMsg("optimization.blackbox.versions.compare_option", {
                    n: version.number,
                    score: formatBlackboxScore(version.score),
                  })}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </div>
      <DiffBlock before={versions[base]?.text ?? ""} after={versions[index]?.text ?? ""} />
    </div>
  );
}

const PILL_TRANSITION = { type: "tween", duration: 0.16, ease: [0.22, 1, 0.36, 1] } as const;

/**
 * Preview / Code / Changes as a proper tab list: one tab stop, ← and → move
 * between the views (mirrored in RTL) and never leak out to the version
 * stepper behind them.
 */
function ViewToggle({
  value,
  onChange,
  canDiff,
}: {
  value: View;
  onChange: (v: View) => void;
  canDiff: boolean;
}) {
  const options: Array<{ value: View; label: string }> = [
    { value: "preview", label: msg("optimization.blackbox.versions.view.preview") },
    { value: "code", label: msg("optimization.blackbox.versions.view.code") },
    ...(canDiff
      ? [{ value: "diff" as const, label: msg("optimization.blackbox.best.view_diff") }]
      : []),
  ];
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = arrowPageStep(event, getActiveDir() === "rtl");
    if (step === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const at = options.findIndex((o) => o.value === value);
    const next = options[(at + step + options.length) % options.length];
    if (!next) return;
    onChange(next.value);
    document.getElementById(`blackbox-view-${next.value}`)?.focus();
  };
  return (
    <div
      role="tablist"
      onKeyDown={onKeyDown}
      className="inline-flex h-7 items-center rounded-md border border-border/60 bg-background/70 p-0.5"
    >
      {options.map((o) => {
        const Icon = VIEW_ICON[o.value];
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            id={`blackbox-view-${o.value}`}
            aria-selected={active}
            aria-controls="blackbox-version-panel"
            aria-label={o.label}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={cn(
              "relative inline-flex h-full cursor-pointer items-center gap-1 rounded px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {active && (
              <motion.span
                layoutId="blackbox-view-pill"
                className="absolute inset-0 rounded bg-primary/10 shadow-sm"
                transition={PILL_TRANSITION}
                aria-hidden="true"
              />
            )}
            <Icon className="relative z-10 size-3.5" aria-hidden="true" />
            <span className="relative z-10 hidden sm:inline">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function downloadText(name: string, text: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function hasVisual(version: CandidateVersion, kind: RenderKind): boolean {
  return isDrawable(kind) || sideInfoImages(version.sideInfo).length > 0;
}

/** True inside an open menu, listbox or select trigger, where the arrow keys belong to Radix. */
function isWithin(target: EventTarget | null, selector: string): boolean {
  const el = target as { closest?: (selector: string) => Element | null } | null;
  return el?.closest?.(selector) != null;
}

function insidePopup(target: EventTarget | null): boolean {
  return isWithin(target, '[role="menu"],[role="listbox"],[role="combobox"]');
}

/**
 * The run's output as an artifact window: the header names it, the body
 * shows the selected version (rendered, as code, or as a diff), and the
 * footer holds the version stepper on one side and the view / copy /
 * download controls — all acting on that version — on the other.
 */
export function BestVersionTab({
  result,
  jobName,
}: {
  result: BlackboxRunResult;
  jobName?: string | null;
}) {
  const versions = useMemo(() => buildVersions(result), [result]);
  const [index, setIndex] = useState(() => defaultVersionIndex(versions));
  const last = versions.length - 1;
  const at = Math.min(index, last);
  const current = versions[at];
  // An agent run that never produced an answer scores 0 with the reason in
  // its side info; without this line the reader only sees the bare score.
  const runError = typeof current?.sideInfo.error === "string" ? current.sideInfo.error : null;
  const kind = detectRenderKind(current?.text ?? "");
  const [view, setView] = useState<View>(() =>
    current && hasVisual(current, kind) ? "preview" : "code",
  );
  if (!current) return null;
  const canDiff = versions.length > 1;
  const activeView: View = view === "diff" && !canDiff ? "code" : view;
  const title = msg("optimization.blackbox.versions.title");
  const slug = (jobName ?? "candidate").replace(/[^\w.-]+/g, "_");
  const fileName = `${slug}-v${current.number}.${RENDER_KIND_EXTENSION[kind]}`;

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // An inner pager that already took the arrow (the preview carousel, an
    // open menu) marks it default-prevented; stepping the version on top of
    // that would remount the panel under it and drop keyboard focus.
    if (event.defaultPrevented || isEditableTarget(event.target) || insidePopup(event.target)) {
      return;
    }
    // The stepper is pinned left-to-right, so ← is always the older version.
    const step = arrowPageStep(event, false);
    const next =
      step !== 0 ? at + step : event.key === "Home" ? 0 : event.key === "End" ? last : null;
    if (next == null || next === at || next < 0 || next > last) return;
    event.preventDefault();
    setIndex(next);
    // Stepping remounts the panel, so focus held inside it would fall to the
    // body and the next arrow press would go nowhere: hand it to the stepper
    // trigger, which stays mounted and keeps ← → live.
    if (isWithin(event.target, "#blackbox-version-panel")) {
      document.getElementById("blackbox-version-trigger")?.focus();
    }
  };

  return (
    <FadeIn>
      <section
        className="overflow-hidden rounded-xl border border-border/60 bg-card shadow-sm"
        aria-label={title}
        aria-keyshortcuts="ArrowLeft ArrowRight Home End"
        onKeyDown={onKeyDown}
      >
        <header className="flex min-h-10 items-center gap-2 border-b border-border/50 bg-muted/30 px-3 py-1.5">
          <Cube className="size-4 shrink-0 text-primary" aria-hidden="true" />
          <HelpTip text={tip("blackbox.versions.section")} className="min-w-0">
            <h3 className="truncate text-sm font-semibold tracking-tight" dir="auto">
              {title}
            </h3>
          </HelpTip>
          <span className="ms-auto shrink-0 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
            {msg(RENDER_KIND_LABEL[kind])}
          </span>
        </header>

        <div className="space-y-3 p-3 sm:p-4">
          {result.regression_guard_applied && (
            <p className="rounded-md border border-amber-300/50 bg-amber-50/60 px-3 py-2 text-xs text-amber-900">
              {msg("optimization.blackbox.best.regression_guard")}
            </p>
          )}
          {!result.versions?.length && versions.length > 1 && (
            <p className="text-xs text-muted-foreground">
              {msg("optimization.blackbox.versions.history_missing")}
            </p>
          )}
          <div
            id="blackbox-version-panel"
            role="tabpanel"
            aria-labelledby={`blackbox-view-${activeView}`}
            key={`${current.number}-${activeView}`}
          >
            {activeView === "preview" && (
              <CandidatePreview version={current} kind={kind} onShowCode={() => setView("code")} />
            )}
            {activeView === "code" && <CodeView version={current} kind={kind} />}
            {activeView === "diff" && <ChangesView versions={versions} index={at} />}
          </div>
        </div>

        <footer className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border/50 bg-muted/20 px-2 py-1.5">
          <VersionRail versions={versions} index={at} onSelect={setIndex} />
          <div className="ms-auto flex shrink-0 items-center gap-0.5">
            <ViewToggle value={activeView} onChange={setView} canDiff={canDiff} />
            <span className="mx-1 h-4 w-px bg-border/70" aria-hidden="true" />
            <CopyButton
              text={current.text}
              size="icon-xs"
              ariaLabel={formatMsg("optimization.blackbox.versions.copy", { n: current.number })}
              copiedAriaLabel={msg("clipboard.copied_short")}
            />
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => downloadText(fileName, current.text)}
              aria-label={formatMsg("optimization.blackbox.versions.download", {
                n: current.number,
              })}
            >
              <DownloadSimple aria-hidden="true" />
            </Button>
          </div>
        </footer>
        {runError && (
          <p
            role="status"
            className="mt-2 flex items-start gap-1.5 rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive"
          >
            <Warning className="mt-px size-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 break-words">
              <span className="font-medium">{msg("optimization.blackbox.versions.run_error")}</span>
              {" · "}
              {runError}
            </span>
          </p>
        )}
      </section>
    </FadeIn>
  );
}
