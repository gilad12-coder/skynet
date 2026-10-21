"use client";

import { msg, formatMsg } from "@/shared/lib/messages";
import { cn } from "@/shared/lib/utils";
import { Trophy, Warning } from "@/shared/ui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/shared/ui/primitives/tooltip";
import { rewardFormatters, rewardPartName } from "@/shared/lib/reward-format";
import {
  readRewardSpec,
  summarizeObservations,
  type RewardComponent,
  type ResponseObservation,
} from "@/shared/lib/reward";
import { RewardFormula, rewardReference } from "@/shared/ui/reward/reward-preview";
import type { BlackboxRunResult } from "@/shared/types/api";
import type { UnifiedSplitCounts } from "@/shared/types/unified-run";

type Better = "higher" | "lower";

interface ComparisonRow {
  key: string;
  label: string;
  /** The part this row scores; the total has none. */
  component?: RewardComponent;
  /** The metric's own words for this part, from `REWARD_SPEC`. */
  meaning?: string;
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
 * The reward breakdown of the baseline and the selected version (SKY-69), in
 * one table with each part's weight beside its values (SKY-84).
 *
 * Time and cost come from each final-run response's trusted observation; the
 * parts and the total come from the run's own scores. A part where the
 * selected version is worse is marked, even when the total rose. Hovering a
 * part's name shows its meaning and the value at which it scores ½.
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
  const rows: ComparisonRow[] = [
    {
      key: "accuracy",
      component: "accuracy",
      label: rewardPartName(spec, "accuracy"),
      meaning: spec.accuracy.meaning,
      baseline: part(result.baseline_named_scores, "accuracy"),
      best: part(result.best_named_scores, "accuracy"),
      better: "higher",
      format: f.score,
    },
    {
      key: "mean_ms",
      component: "speed",
      label: spec.speed.name || msg("optimization.reward.mean_time"),
      meaning: spec.speed.meaning,
      baseline: baselineObs.meanMs,
      best: bestObs.meanMs,
      better: "lower",
      format: f.ms,
    },
    {
      key: "cost",
      component: "cost",
      label: spec.cost.name || msg("optimization.reward.cost_per_response"),
      meaning: spec.cost.meaning,
      baseline: baselineObs.meanCostUsd,
      best: bestObs.meanCostUsd,
      better: "lower",
      format: f.usd,
    },
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
      <h3
        id="reward-comparison-title"
        className="flex items-center gap-2 text-sm font-medium text-foreground"
      >
        <Trophy className="size-4 shrink-0 text-primary" aria-hidden="true" />
        {msg("optimization.reward.title")}
      </h3>
      <RewardFormula spec={spec} />
      <TooltipProvider>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[26rem] text-xs">
            <thead>
              <tr className="border-b border-border/60">
                <th scope="col" className={th}>
                  {msg("optimization.logged_metrics.metric_col")}
                </th>
                <th scope="col" className={th}>
                  {msg("submit.v2.reward.col.weight")}
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
                      {row.component ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span
                              tabIndex={0}
                              data-meaning={row.key}
                              className="cursor-help underline decoration-muted-foreground/50 decoration-dotted underline-offset-2"
                            >
                              {row.label}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs space-y-0.5">
                            {row.meaning && (
                              <p>
                                <bdi>{row.meaning}</bdi>
                              </p>
                            )}
                            <p className="opacity-80">
                              {msg("submit.v2.reward.col.reference")}:{" "}
                              <bdi>{rewardReference(spec, row.component)}</bdi>
                            </p>
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        row.label
                      )}
                    </th>
                    <td className={td} data-weight={row.key}>
                      <bdi dir="ltr">{f.pct(row.component ? spec.weights[row.component] : 1)}</bdi>
                    </td>
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
      </TooltipProvider>
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

/** Report whether the split explicitly says no held-out final score exists. */
export function isNotHeldOut(splitCounts: unknown): boolean {
  const split = splitCounts as Partial<UnifiedSplitCounts> | null | undefined;
  return !!split && typeof split === "object" && "held_out" in split && split.held_out === false;
}

/** Say so when too few cases left none for a held-out final score. */
export function HeldOutNotice({ splitCounts }: { splitCounts: unknown }) {
  if (!isNotHeldOut(splitCounts)) {
    return null;
  }
  return (
    <p
      role="note"
      data-notice="not-held-out"
      className="flex items-start gap-2 rounded-xl border border-[var(--warning-border)] bg-[var(--warning-dim)] px-4 py-3 text-xs text-[var(--warning)]"
    >
      <Warning className="mt-px size-3.5 shrink-0" aria-hidden="true" />
      <span>{msg("optimization.reward.not_held_out")}</span>
    </p>
  );
}
