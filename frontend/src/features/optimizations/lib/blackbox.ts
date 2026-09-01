/** Black-box ("optimize anything") run helpers. */

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
