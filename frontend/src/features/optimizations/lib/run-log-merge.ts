import type { OptimizationLogEntry } from "@/shared/types/api";

/** Event the backend stores as a run's last line once its owner's storage is full. */
export const QUOTA_FULL_EVENT = "log.quota_full";

/** Highest row id in `logs`, or null when none carries one. */
export function maxLogId(logs: readonly OptimizationLogEntry[] | undefined): number | null {
  let max: number | null = null;
  for (const log of logs ?? []) {
    if (log.id != null && (max === null || log.id > max)) max = log.id;
  }
  return max;
}

/**
 * Join the fetched log with rows the live stream delivered since. Streamed rows
 * the fetched log already holds are dropped, so the two sources never double a
 * line. Returns `fetched` itself when the stream added nothing.
 */
export function mergeLiveLogs(
  fetched: readonly OptimizationLogEntry[],
  live: readonly OptimizationLogEntry[],
): OptimizationLogEntry[] {
  if (live.length === 0) return fetched as OptimizationLogEntry[];
  const held = new Set<number>();
  for (const log of fetched) if (log.id != null) held.add(log.id);
  const extra = live.filter((log) => log.id == null || !held.has(log.id));
  return extra.length === 0 ? (fetched as OptimizationLogEntry[]) : [...fetched, ...extra];
}

/** Streamed rows the fetched log does not hold yet; the rest can be let go. */
export function pruneLiveLogs(
  fetched: readonly OptimizationLogEntry[],
  live: readonly OptimizationLogEntry[],
): OptimizationLogEntry[] {
  const fetchedMax = maxLogId(fetched);
  if (fetchedMax === null) return live as OptimizationLogEntry[];
  const kept = live.filter((log) => log.id == null || log.id > fetchedMax);
  return kept.length === live.length ? (live as OptimizationLogEntry[]) : kept;
}
