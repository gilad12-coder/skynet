"use client";

import type React from "react";
import { Badge } from "@/shared/ui/primitives/badge";
import type { OptimizationSummaryResponse } from "@/shared/types/api";
import { formatBlackboxDelta, formatBlackboxScore, formatPercent } from "@/shared/lib";
import { msg } from "@/shared/lib/messages";

export function typeBadge(jobType: string) {
  if (jobType === "grid_search") {
    return (
      <Badge variant="outline" className="border-primary-fill/30 text-primary">
        {msg("auto.features.dashboard.lib.status.badges.1")}
      </Badge>
    );
  }
  if (jobType === "blackbox") {
    return (
      <Badge variant="outline" className="border-primary-fill/45 text-primary">
        {msg("optimization.blackbox.badge")}
      </Badge>
    );
  }
  return <Badge variant="secondary">{msg("auto.features.dashboard.lib.status.badges.2")}</Badge>;
}

export function formatScore(job: OptimizationSummaryResponse): React.ReactNode {
  const baseline = job.baseline_test_metric;
  const optimized = job.optimized_test_metric;
  const improvement = job.metric_improvement;

  if (baseline == null && optimized == null) return "-";

  // Black-box (and Auto) runs report raw scorer values, often 0–1, not a
  // 0–100 percentage; format them the way the run page does.
  const isBlackbox = job.optimization_type === "blackbox";
  const fmtScore = isBlackbox ? formatBlackboxScore : formatPercent;

  if (baseline != null && optimized != null && improvement != null) {
    const color =
      improvement > 0
        ? "text-[var(--success)]"
        : improvement < 0
          ? "text-[var(--danger)]"
          : "text-muted-foreground";
    const delta = isBlackbox
      ? formatBlackboxDelta(improvement)
      : `${improvement > 0 ? "+" : ""}${improvement.toFixed(1)}%`;
    return (
      <span
        className="inline-flex items-center gap-1 text-xs whitespace-nowrap"
        title={`${fmtScore(baseline)} → ${fmtScore(optimized)}`}
      >
        <span className="font-medium">{fmtScore(optimized)}</span>
        <span className={`${color} font-medium`}>({delta})</span>
      </span>
    );
  }

  if (optimized != null) return <span className="font-medium text-xs">{fmtScore(optimized)}</span>;
  if (baseline != null)
    return <span className="text-muted-foreground text-xs">{fmtScore(baseline)}</span>;
  return "-";
}
