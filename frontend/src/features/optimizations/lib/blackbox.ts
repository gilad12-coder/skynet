/**
 * Black-box ("optimize anything") run helpers.
 *
 * Black-box scores are raw scorer values — never a 0–100 percentage — so the
 * run page formats them verbatim instead of routing through `formatPercent`.
 */

import type { BlackboxLaneResult, ProgressEvent } from "@/shared/types/api";
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

export interface LaneView {
  engine: string;
  phase: BlackboxLaneResult["phase"];
  status: BlackboxLaneResult["status"] | "running";
  best_score?: number | null;
  scorer_runs?: number;
  error?: string | null;
  budget?: number;
}

/**
 * Lane timeline for the overview band. The persisted result is authoritative
 * once the run finishes; while it is live the `lane_started` /
 * `lane_completed` events are folded into the same shape.
 */
export function deriveLanes(
  events: ProgressEvent[],
  finalLanes: BlackboxLaneResult[] | null | undefined,
): LaneView[] {
  if (finalLanes && finalLanes.length > 0) return finalLanes;
  const lanes: LaneView[] = [];
  for (const event of events) {
    const m = event.metrics;
    if (event.event === "lane_started" && typeof m.engine === "string") {
      lanes.push({
        engine: m.engine,
        phase: (m.phase as LaneView["phase"]) ?? "explore",
        status: "running",
        budget: typeof m.budget === "number" ? m.budget : undefined,
      });
    } else if (event.event === "lane_completed" && typeof m.engine === "string") {
      const lane = [...lanes]
        .reverse()
        .find((l) => l.engine === m.engine && l.phase === (m.phase ?? l.phase));
      const patch = {
        status: (m.status as LaneView["status"]) ?? "completed",
        best_score: typeof m.best_score === "number" ? m.best_score : null,
        scorer_runs: typeof m.scorer_runs === "number" ? m.scorer_runs : undefined,
        error: typeof m.error === "string" ? m.error : null,
      };
      if (lane) Object.assign(lane, patch);
      else
        lanes.push({
          engine: m.engine,
          phase: (m.phase as LaneView["phase"]) ?? "explore",
          ...patch,
        });
    }
  }
  return lanes;
}
