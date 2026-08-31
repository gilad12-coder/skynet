"use client";

import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Cube, DownloadSimple, Trophy } from "@/shared/ui/icons";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/primitives/card";
import { Badge } from "@/shared/ui/primitives/badge";
import { Button } from "@/shared/ui/primitives/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/primitives/select";
import { FadeIn } from "@/shared/ui/motion";
import { HelpTip } from "@/shared/ui/help-tip";
import type { BlackboxRunResult } from "@/shared/types/api";
import { formatMsg, msg } from "@/shared/lib/messages";
import { tip } from "@/shared/lib/tooltips";
import { CandidatePreview, isDrawable } from "./CandidatePreview";
import { VersionRail } from "./VersionRail";
import { formatBlackboxScore } from "../lib/blackbox";
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
  sideInfoImages,
  type RenderKind,
} from "../lib/candidate-render";
import { cn } from "@/shared/lib/utils";

const CodeEditor = dynamic(() => import("@/shared/ui/code-editor").then((m) => m.CodeEditor), {
  ssr: false,
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
  return (
    <div
      role="tablist"
      className="inline-flex items-center rounded-md border border-border/60 bg-background/70 p-0.5"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          id={`blackbox-view-${o.value}`}
          aria-selected={o.value === value}
          aria-controls="blackbox-version-panel"
          onClick={() => onChange(o.value)}
          className={cn(
            "relative cursor-pointer rounded px-2 py-1 text-xs font-medium transition-colors",
            o.value === value ? "text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.value === value && (
            <motion.span
              layoutId="blackbox-view-pill"
              className="absolute inset-0 rounded bg-primary/10 shadow-sm"
              transition={PILL_TRANSITION}
              aria-hidden="true"
            />
          )}
          <span className="relative z-10">{o.label}</span>
        </button>
      ))}
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

/**
 * The run's output as a versioned artifact: v0 is the starting point, every
 * distinct text the scorer saw is a version, and each one can be previewed,
 * read as code, or diffed against any other.
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
  const current = versions[Math.min(index, versions.length - 1)];
  const kind = detectRenderKind(current?.text ?? "");
  const [view, setView] = useState<View>(() =>
    current && hasVisual(current, kind) ? "preview" : "code",
  );
  if (!current) return null;
  const canDiff = versions.length > 1;
  const activeView: View = view === "diff" && !canDiff ? "code" : view;
  const slug = (jobName ?? "candidate").replace(/[^\w.-]+/g, "_");
  const fileName = `${slug}-v${current.number}.${RENDER_KIND_EXTENSION[kind]}`;

  return (
    <FadeIn>
      <Card className="relative overflow-hidden border-primary/30 bg-gradient-to-br from-primary/5 to-primary/10">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <Cube className="size-4 text-primary" aria-hidden="true" />
            <HelpTip text={tip("blackbox.versions.section")}>
              <span className="font-bold tracking-tight">
                {msg("optimization.blackbox.versions.title")}
              </span>
            </HelpTip>
            <Badge variant="secondary" size="sm" className="font-mono tabular-nums">
              {formatMsg("optimization.blackbox.versions.label", { n: current.number })}
            </Badge>
            {current.isSeed && (
              <HelpTip text={tip("blackbox.versions.seed")}>
                <Badge variant="outline" size="sm">
                  {msg("optimization.blackbox.best.seed_title")}
                </Badge>
              </HelpTip>
            )}
            {current.isBest && (
              <HelpTip text={tip("blackbox.versions.best")}>
                <Badge variant="default" size="sm" className="gap-1">
                  <Trophy className="size-3" aria-hidden="true" />
                  {msg("optimization.blackbox.versions.best")}
                </Badge>
              </HelpTip>
            )}
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <ViewToggle value={activeView} onChange={setView} canDiff={canDiff} />
            {current.isSeed && result.baseline_test_metric != null && (
              <Badge variant="outline" size="sm" className="tabular-nums">
                {formatMsg("optimization.blackbox.best.seed_score", {
                  score: formatBlackboxScore(result.baseline_test_metric),
                })}
              </Badge>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => downloadText(fileName, current.text)}
              aria-label={msg("optimization.blackbox.best.download")}
            >
              <DownloadSimple className="size-4" aria-hidden="true" />
              <span className="hidden sm:inline">{msg("optimization.blackbox.best.download")}</span>
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
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
            {activeView === "diff" && <ChangesView versions={versions} index={index} />}
          </div>
          {canDiff && <VersionRail versions={versions} index={index} onSelect={setIndex} />}
        </CardContent>
      </Card>
    </FadeIn>
  );
}
