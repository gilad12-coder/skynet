"use client";

import { msg, formatMsg } from "@/shared/lib/messages";
import { cn } from "@/shared/lib/utils";
import { rewardFormatters, rewardPartLabel } from "@/shared/lib/reward-format";
import {
  REWARD_COMPONENTS,
  readRewardSpec,
  summarizeObservations,
  type RewardComponent,
  type ResponseObservation,
} from "@/shared/lib/reward";
import type { BlackboxRunResult } from "@/shared/types/api";
import type { UnifiedSplitCounts } from "@/shared/types/unified-run";

type Better = "higher" | "lower";

interface ComparisonRow {
  key: string;
  label: string;
  baseline: number | null;
  best: number | null;
  better: Better;
  format: (value: number | null) => string;
  strong?: boolean;
}

/** Whether the selected version is worse than the baseline on this row. */
function isLoss(row: ComparisonRow): boolean {
  if (row.baseline == null || row.best == null) return false;
  const delta = row.best - row.baseline;
  // Ignore float noise so an equal value never reads as a loss.
  if (Math.abs(delta) <= 1e-9 * Math.max(1, Math.abs(row.baseline))) return false;
  return row.better === "higher" ? delta < 0 : delta > 0;
}

/** The metric code a run saved: the unified workspace's, else a legacy scorer's. */
export function savedMetricCode(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as {
    workspace?: { metric_code?: unknown };
    scorer?: { metric_code?: unknown };
  };
  const code = record.workspace?.metric_code ?? record.scorer?.metric_code;
  return typeof code === "string" ? code : null;
}

/**
 * The baseline and the selected version on accuracy, speed and cost (SKY-69).
 *
 * Time and cost come from each final-run response's trusted observation; the
 * parts and the total come from the run's own scores. A part where the
 * selected version is worse is marked, even when the total rose.
 */
export function RewardComparison({
  result,
  metricCode,
}: {
  result: BlackboxRunResult;
  metricCode: string | null;
}) {
  const read = readRewardSpec(metricCode);
  if (read.kind !== "spec") return null;
  const { spec } = read;
  const f = rewardFormatters();
  const cases = result.case_results ?? [];
  const baselineObs = summarizeObservations(cases.map((c) => c.baseline_observation));
  const bestObs = summarizeObservations(cases.map((c) => c.best_observation));
  const part = (named: BlackboxRunResult["baseline_named_scores"], name: RewardComponent) => {
    const value = named?.[name]?.score;
    return typeof value === "number" ? value : null;
  };
  const contribution = (value: number | null, name: RewardComponent) =>
    value == null ? null : value * spec.weights[name];
  const rows: ComparisonRow[] = [
    {
      key: "accuracy",
      label: rewardPartLabel("accuracy"),
      baseline: part(result.baseline_named_scores, "accuracy"),
      best: part(result.best_named_scores, "accuracy"),
      better: "higher",
      format: f.score,
    },
    {
      key: "mean_ms",
      label: msg("optimization.reward.mean_time"),
      baseline: baselineObs.meanMs,
      best: bestObs.meanMs,
      better: "lower",
      format: f.ms,
    },
    {
      key: "p95_ms",
      label: msg("optimization.reward.p95_time"),
      baseline: baselineObs.p95Ms,
      best: bestObs.p95Ms,
      better: "lower",
      format: f.ms,
    },
    {
      key: "cost",
      label: msg("optimization.reward.cost_per_response"),
      baseline: baselineObs.meanCostUsd,
      best: bestObs.meanCostUsd,
      better: "lower",
      format: f.usd,
    },
    ...REWARD_COMPONENTS.map(
      (name): ComparisonRow => ({
        key: `contribution_${name}`,
        label: formatMsg("optimization.reward.contribution", {
          part: rewardPartLabel(name),
          weight: f.pct(spec.weights[name]),
        }),
        baseline: contribution(part(result.baseline_named_scores, name), name),
        best: contribution(part(result.best_named_scores, name), name),
        better: "higher",
        format: f.score,
      }),
    ),
    {
      key: "total",
      label: msg("optimization.reward.total"),
      baseline: result.baseline_score ?? null,
      best: result.best_score ?? null,
      better: "higher",
      format: f.score,
      strong: true,
    },
  ];
  const losses = rows.filter(isLoss);
  const unpriced = baselineObs.unpriced + bestObs.unpriced;
  const th = "px-2 py-1.5 text-start text-[0.6875rem] font-medium text-muted-foreground";
  const td = "px-2 py-1.5 tabular-nums";
  return (
    <section
      aria-labelledby="reward-comparison-title"
      className="space-y-2 rounded-xl border border-border bg-card px-4 py-3.5"
    >
      <h3 id="reward-comparison-title" className="text-sm font-medium text-foreground">
        {msg("optimization.reward.title")}
      </h3>
      <p className="text-xs text-muted-foreground">
        {formatMsg("optimization.reward.desc", { count: cases.length })}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[26rem] text-xs">
          <thead>
            <tr className="border-b border-border/60">
              <th scope="col" className={th}>
                {msg("optimization.logged_metrics.metric_col")}
              </th>
              <th scope="col" className={th}>
                {msg("optimization.logged_metrics.baseline_col")}
              </th>
              <th scope="col" className={th}>
                {msg("optimization.reward.selected_col")}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const loss = isLoss(row);
              return (
                <tr
                  key={row.key}
                  data-row={row.key}
                  data-loss={loss ? "true" : undefined}
                  className={cn(
                    "border-b border-border/30 last:border-b-0",
                    row.strong && "font-semibold",
                  )}
                >
                  <th
                    scope="row"
                    className={cn(td, "text-start font-normal", row.strong && "font-semibold")}
                  >
                    {row.label}
                  </th>
                  <td className={td}>
                    <bdi dir="ltr">{row.format(row.baseline)}</bdi>
                  </td>
                  <td className={cn(td, loss && "text-[var(--danger)]")}>
                    <bdi dir="ltr">{row.format(row.best)}</bdi>
                    {loss && (
                      <span className="ms-1.5 text-[0.6875rem] font-medium">
                        {msg("optimization.reward.worse")}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {losses.length > 0 && (
        <p role="note" className="text-xs text-[var(--danger)]">
          {formatMsg("optimization.reward.losses", {
            parts: f.list(losses.map((row) => row.label)),
          })}
        </p>
      )}
      {unpriced > 0 && (
        <p className="text-xs text-[var(--warning)]">
          {formatMsg("optimization.reward.unpriced", { count: unpriced })}
        </p>
      )}
    </section>
  );
}

/** Say so when too few cases left none for a held-out final score. */
export function HeldOutNotice({ splitCounts }: { splitCounts: unknown }) {
  const split = splitCounts as Partial<UnifiedSplitCounts> | null | undefined;
  if (!split || typeof split !== "object" || !("held_out" in split) || split.held_out !== false) {
    return null;
  }
  return (
    <p
      role="note"
      data-notice="not-held-out"
      className="rounded-xl border border-[var(--warning-border)] bg-[var(--warning-dim)] px-4 py-3 text-xs text-[var(--warning)]"
    >
      {msg("optimization.reward.not_held_out")}
    </p>
  );
}
