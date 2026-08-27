"use client";

import { Cube, DownloadSimple } from "@/shared/ui/icons";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/primitives/card";
import { Badge } from "@/shared/ui/primitives/badge";
import { Button } from "@/shared/ui/primitives/button";
import { FadeIn } from "@/shared/ui/motion";
import type { BlackboxCandidate, BlackboxRunResult } from "@/shared/types/api";
import { formatMsg, msg } from "@/shared/lib/messages";
import { CopyButton } from "./ui-primitives";
import { formatBlackboxDelta, formatBlackboxScore } from "../lib/blackbox";

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
            <CandidateBlock candidate={result.best_candidate} />
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
