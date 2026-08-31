/**
 * Black-box ("optimize anything") run helpers.
 *
 * Black-box scores are raw scorer values — never a 0–100 percentage — so the
 * run page formats them verbatim instead of routing through `formatPercent`.
 */

import type { ProgressEvent } from "@/shared/types/api";
import type { ScorePoint } from "./extract-scores";

/** Score progression from `optimizer_progress` events (one point per scorer run). */
export function extractBlackboxScorePoints(events: ProgressEvent[]): ScorePoint[] {
  const points: ScorePoint[] = [];
  let bestSoFar = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    if (event.event !== "optimizer_progress") continue;
    const trial = event.metrics.tqdm_n;
    const score = event.metrics.last_score;
    if (typeof trial !== "number" || typeof score !== "number") continue;
    const best = event.metrics.best_score;
    bestSoFar = typeof best === "number" ? best : Math.max(bestSoFar, score);
    points.push({ trial, score, best: bestSoFar });
  }
  return points;
}

export function formatBlackboxScore(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return String(Number(value.toFixed(4)) + 0);
}

export function formatBlackboxDelta(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const rounded = Number(value.toFixed(4)) + 0;
  return `${rounded >= 0 ? "+" : ""}${rounded}`;
}
