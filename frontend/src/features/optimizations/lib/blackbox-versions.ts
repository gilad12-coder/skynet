import type { BlackboxCandidate, BlackboxRunResult, BlackboxVersion } from "@/shared/types/api";

/** One entry of the run's artifact history: the starting point, then every distinct version in the order it appeared. */
export interface CandidateVersion {
  /** 0 for the starting point, then 1..n in first-seen order. */
  number: number;
  candidate: BlackboxCandidate;
  text: string;
  /** Mean score inside the budget; falls back to the held-out metric for versions never scored there. */
  score: number | null;
  evals: number;
  /** Scorer run that first scored it; null when it never went through the budget. */
  firstRun: number | null;
  sideInfo: Record<string, unknown>;
  isSeed: boolean;
  /** The version the run returned. */
  isBest: boolean;
  /** Beat every version before it — an accepted step of the trajectory. */
  isImprovement: boolean;
}

export function candidateToText(candidate: BlackboxCandidate | null | undefined): string {
  if (candidate == null) return "";
  if (typeof candidate === "string") return candidate;
  return Object.entries(candidate)
    .map(([key, value]) => `## ${key}\n${value}`)
    .join("\n\n");
}

function fromRecord(
  candidate: BlackboxCandidate,
  text: string,
  record: BlackboxVersion | null,
  fallbackScore: number | null | undefined,
  isSeed: boolean,
): CandidateVersion {
  return {
    number: 0,
    candidate,
    text,
    score: record?.score ?? fallbackScore ?? null,
    evals: record?.evals ?? 0,
    firstRun: record?.first_run ?? null,
    sideInfo: record?.side_info ?? {},
    isSeed,
    isBest: false,
    isImprovement: false,
  };
}

/**
 * Lay the run out as versions: v0 is the starting point, then every distinct
 * text the scorer saw, then the returned best when the history lacks it
 * (runs recorded before version tracking). Identical texts collapse into one
 * version, so stepping through the list never shows the same content twice.
 */
export function buildVersions(result: BlackboxRunResult): CandidateVersion[] {
  const seedText = candidateToText(result.seed_candidate);
  const bestText = candidateToText(result.best_candidate);
  const history = [...(result.versions ?? [])].sort((a, b) => a.first_run - b.first_run);
  const seen = new Set<string>();
  const versions: CandidateVersion[] = [];

  if (result.seed_candidate != null && seedText.length > 0) {
    const record = history.find((v) => candidateToText(v.candidate) === seedText) ?? null;
    versions.push(
      fromRecord(result.seed_candidate, seedText, record, result.baseline_test_metric, true),
    );
    seen.add(seedText);
  }
  for (const record of history) {
    const text = candidateToText(record.candidate);
    if (seen.has(text)) continue;
    seen.add(text);
    versions.push(fromRecord(record.candidate, text, record, null, false));
  }
  if (bestText.length > 0 && !seen.has(bestText)) {
    versions.push(
      fromRecord(result.best_candidate, bestText, null, result.optimized_test_metric, false),
    );
  }

  let bestSoFar = -Infinity;
  versions.forEach((version, index) => {
    version.number = index;
    version.isBest = version.text === bestText;
    version.isImprovement = !version.isSeed && version.score != null && version.score > bestSoFar;
    if (version.score != null) bestSoFar = Math.max(bestSoFar, version.score);
  });
  return versions;
}

/** Index of the version a fresh view should open on: the returned best, else the last one. */
export function defaultVersionIndex(versions: CandidateVersion[]): number {
  const best = versions.findIndex((v) => v.isBest);
  return best >= 0 ? best : Math.max(0, versions.length - 1);
}
