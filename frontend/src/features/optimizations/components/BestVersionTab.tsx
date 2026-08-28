"use client";

import { useMemo, useState } from "react";
import { Cube, DownloadSimple } from "@/shared/ui/icons";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/primitives/card";
import { Badge } from "@/shared/ui/primitives/badge";
import { Button } from "@/shared/ui/primitives/button";
import { FadeIn } from "@/shared/ui/motion";
import type { BlackboxCandidate, BlackboxRunResult } from "@/shared/types/api";
import { formatMsg, msg } from "@/shared/lib/messages";
import { CopyButton } from "./ui-primitives";
import { formatBlackboxDelta, formatBlackboxScore } from "../lib/blackbox";
import { countChanges, diffRows } from "../lib/blackbox-diff";
import { cn } from "@/shared/lib/utils";

// Same tints the trajectory drawer uses for accepted / rejected edits, so a
// diff reads the same everywhere in the run view.
const ADDED_BG = "rgba(138, 154, 91, 0.28)";
const ADDED_EMPHASIS_BG = "rgba(138, 154, 91, 0.55)";
const ADDED_FG = "#3f4d1f";
const REMOVED_BG = "rgba(168, 90, 59, 0.22)";
const REMOVED_EMPHASIS_BG = "rgba(168, 90, 59, 0.45)";
const REMOVED_FG = "#6e2e16";

type BestView = "best" | "diff";

function candidateToText(candidate: BlackboxCandidate | null | undefined): string {
  if (candidate == null) return "";
  if (typeof candidate === "string") return candidate;
  return Object.entries(candidate)
    .map(([key, value]) => `## ${key}\n${value}`)
    .join("\n\n");
}

function CandidateBlock({ candidate }: { candidate: BlackboxCandidate }) {
  if (typeof candidate === "string") {
    return (
      <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/50 bg-muted/30 p-4 font-mono text-[0.8125rem] leading-relaxed">
        {candidate}
      </pre>
    );
  }
  return (
    <div className="space-y-3">
      {Object.entries(candidate).map(([key, value]) => (
        <div key={key}>
          <p className="mb-1 font-mono text-xs font-semibold text-muted-foreground">{key}</p>
          <pre className="max-h-[24rem] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/50 bg-muted/30 p-3 font-mono text-[0.8125rem] leading-relaxed">
            {value}
          </pre>
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

function ViewToggle({ value, onChange }: { value: BestView; onChange: (v: BestView) => void }) {
  const options: Array<{ value: BestView; label: string }> = [
    { value: "best", label: msg("optimization.blackbox.best.title") },
    { value: "diff", label: msg("optimization.blackbox.best.view_diff") },
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
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            "cursor-pointer rounded px-2 py-1 text-xs font-medium transition-colors",
            o.value === value
              ? "bg-primary/10 text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
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

export function BestVersionTab({
  result,
  jobName,
}: {
  result: BlackboxRunResult;
  jobName?: string | null;
}) {
  const bestText = candidateToText(result.best_candidate);
  const seedText = candidateToText(result.seed_candidate);
  const fileName = `${(jobName ?? "best-candidate").replace(/[^\w.-]+/g, "_")}.txt`;
  const hasSeed = result.seed_candidate != null && seedText.length > 0;
  const [view, setView] = useState<BestView>("best");
  const showDiff = hasSeed && view === "diff";

  return (
    <div className="space-y-4">
      <FadeIn>
        <Card className="relative overflow-hidden border-primary/30 bg-gradient-to-br from-primary/5 to-primary/10">
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <Cube className="size-4 text-primary" aria-hidden="true" />
              <span className="font-bold tracking-tight">
                {msg("optimization.blackbox.best.title")}
              </span>
            </CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              {hasSeed && <ViewToggle value={view} onChange={setView} />}
              <Badge variant="outline" size="sm" className="font-mono">
                {result.engine_used}
              </Badge>
              {result.optimized_test_metric != null && (
                <Badge variant="secondary" size="sm" className="tabular-nums">
                  {formatMsg("optimization.blackbox.best.score", {
                    score: formatBlackboxScore(result.optimized_test_metric),
                    delta: formatBlackboxDelta(result.metric_improvement),
                  })}
                </Badge>
              )}
              <CopyButton text={bestText} />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => downloadText(fileName, bestText)}
                aria-label={msg("optimization.blackbox.best.download")}
              >
                <DownloadSimple className="size-4" aria-hidden="true" />
                <span className="hidden sm:inline">
                  {msg("optimization.blackbox.best.download")}
                </span>
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {result.regression_guard_applied && (
              <p className="rounded-md border border-amber-300/50 bg-amber-50/60 px-3 py-2 text-xs text-amber-900">
                {msg("optimization.blackbox.best.regression_guard")}
              </p>
            )}
            {showDiff ? (
              <DiffBlock before={seedText} after={bestText} />
            ) : (
              <CandidateBlock candidate={result.best_candidate} />
            )}
          </CardContent>
        </Card>
      </FadeIn>

      {result.seed_candidate != null && seedText.length > 0 && (
        <FadeIn delay={0.05}>
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
              <CardTitle className="text-base">
                <span className="font-bold tracking-tight">
                  {msg("optimization.blackbox.best.seed_title")}
                </span>
              </CardTitle>
              <div className="flex items-center gap-2">
                {result.baseline_test_metric != null && (
                  <Badge variant="outline" size="sm" className="tabular-nums">
                    {formatMsg("optimization.blackbox.best.seed_score", {
                      score: formatBlackboxScore(result.baseline_test_metric),
                    })}
                  </Badge>
                )}
                <CopyButton text={seedText} />
              </div>
            </CardHeader>
            <CardContent>
              <CandidateBlock candidate={result.seed_candidate} />
            </CardContent>
          </Card>
        </FadeIn>
      )}
    </div>
  );
}
