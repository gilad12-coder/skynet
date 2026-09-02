/** Black-box ("optimize anything") run helpers. */

import type { CandidateMetrics } from "@/features/trajectory";
import type { ScorePoint } from "./extract-scores";

/**
 * Score progression from a lane's candidate events: one point per fully
 * scored version at its mean over the cases, with the best mean so far.
 *
 * `optimizer_progress` events are no source for this: each carries a single
 * scorer run, and its `best_score` is the eval server's best running mean,
 * which a version's first strong case inflates until its weaker ones come in.
 */
export function extractBlackboxScorePoints(candidates: CandidateMetrics[]): ScorePoint[] {
  const points: ScorePoint[] = [];
  let best = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    const parsed = Number(candidate.candidate_id);
    const trial = Number.isFinite(parsed) ? parsed : points.length;
    best = Math.max(best, candidate.score);
    points.push({ trial, score: candidate.score, best });
  }
  return points;
}
