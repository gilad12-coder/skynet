/**
 * Scorer runs the final run spends after the search, outside `max_scorer_runs`.
 *
 * The backend scores the starting version and the winner afresh: once each
 * without cases, once per case each with cases. Without a starting version
 * only the winner is scored.
 */
export function blackboxFinalScorerRuns(caseCount: number, hasStartingVersion: boolean): number {
  const perVersion = Math.max(1, Math.floor(caseCount));
  return (hasStartingVersion ? 2 : 1) * perVersion;
}

/** Every scorer run a black-box run may make: the search budget plus the final run. */
export function blackboxEstimatedScorerRuns(
  maxScorerRuns: number,
  caseCount: number,
  hasStartingVersion: boolean,
): number {
  return Math.max(0, maxScorerRuns) + blackboxFinalScorerRuns(caseCount, hasStartingVersion);
}
