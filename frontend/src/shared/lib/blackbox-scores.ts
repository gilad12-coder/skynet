import type { BlackboxNamedScore, BlackboxRunResult } from "@/shared/types/api";

/** The final run's score of the starting version; older runs stored it as `baseline_test_metric`. */
export function blackboxBaselineScore(result: BlackboxRunResult | null | undefined): number | null {
  return result?.baseline_score ?? result?.baseline_test_metric ?? null;
}

/** The final run's score of the winner; older runs stored it as `optimized_test_metric`. */
export function blackboxBestScore(result: BlackboxRunResult | null | undefined): number | null {
  return result?.best_score ?? result?.optimized_test_metric ?? null;
}

/** Feedback text of a side-info mapping, when the scorer gave one. */
export function sideInfoFeedback(sideInfo: Record<string, unknown> | null | undefined): string | null {
  const feedback = sideInfo?.feedback;
  return typeof feedback === "string" && feedback.trim() ? feedback : null;
}

/**
 * Named scores carried in a side-info mapping. Current runs store
 * `{name: {score, feedback}}`; older runs may store `{name: number}`, read
 * with empty feedback. Anything else is skipped.
 */
export function sideInfoNamedScores(
  sideInfo: Record<string, unknown> | null | undefined,
): Record<string, BlackboxNamedScore> {
  const raw = sideInfo?.scores;
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const named: Record<string, BlackboxNamedScore> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "number") {
      named[name] = { score: value, feedback: "" };
    } else if (value != null && typeof value === "object") {
      const entry = value as Record<string, unknown>;
      if (typeof entry.score !== "number") continue;
      named[name] = {
        score: entry.score,
        feedback: typeof entry.feedback === "string" ? entry.feedback : "",
      };
    }
  }
  return named;
}

/** One named score with the starting version's and the winner's figures side by side. */
export interface NamedScoreRow {
  name: string;
  baseline: BlackboxNamedScore | null;
  best: BlackboxNamedScore | null;
}

/** Pair the final run's named scores by name, the winner's order first. */
export function namedScoreRows(result: BlackboxRunResult | null | undefined): NamedScoreRow[] {
  const baseline = result?.baseline_named_scores ?? {};
  const best = result?.best_named_scores ?? {};
  const names = Array.from(new Set([...Object.keys(best), ...Object.keys(baseline)]));
  return names.map((name) => ({ name, baseline: baseline[name] ?? null, best: best[name] ?? null }));
}

/** Whether a scorer error is the backend's refusal of a result without feedback. */
export function isMissingFeedbackError(error: string | null | undefined): boolean {
  return typeof error === "string" && error.includes("must return feedback");
}
