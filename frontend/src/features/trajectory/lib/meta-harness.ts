import type { ProgressEvent } from "@/shared/types/api";
import type { CandidateMetrics } from "./types";

const CANDIDATE_EVENT = "candidate";
const REJECTED_EVENT = "candidate_rejected";
const MINIBATCH_EVENT = "minibatch_feedback";
const CASE_SCORED_EVENT = "case_scored";
const LANE_STARTED_EVENT = "lane_started";

export const META_HARNESS_ENGINE = "meta_harness";

function laneOf(event: ProgressEvent): number {
  const lane = event.metrics?.lane_index;
  return typeof lane === "number" && Number.isInteger(lane) && lane > 0 ? lane : 0;
}

/**
 * Index of the lane the newest version events belong to.
 *
 * A version's case scores stream in before its candidate event, so both count:
 * otherwise the first version of a new lane would be read as part of the
 * previous lane until it completes.
 */
export function latestVersionLane(events: ProgressEvent[]): number {
  let latest = 0;
  for (const event of events) {
    if (event.event === CANDIDATE_EVENT || event.event === CASE_SCORED_EVENT) {
      latest = Math.max(latest, laneOf(event));
    }
  }
  return latest;
}

/**
 * Keep only the version events of the newest lane — ``scopeToLatestLane`` with
 * per-case scores counted as version events too.
 */
export function scopeToVersionLane(events: ProgressEvent[]): ProgressEvent[] {
  const latest = latestVersionLane(events);
  if (latest === 0) return events;
  const laned = new Set([CANDIDATE_EVENT, REJECTED_EVENT, MINIBATCH_EVENT, CASE_SCORED_EVENT]);
  return events.filter(
    (event) => event.event == null || !laned.has(event.event) || laneOf(event) === latest,
  );
}

/**
 * Engine of the lane the newest versions belong to.
 *
 * ``lane_started`` events carry the engine but no lane index; every strategy
 * mode starts its lanes in order, so the N-th one announces lane N.
 */
export function engineOfLatestLane(events: ProgressEvent[]): string | null {
  const lane = latestVersionLane(events);
  let seen = 0;
  for (const event of events) {
    if (event.event !== LANE_STARTED_EVENT) continue;
    if (seen === lane) {
      const engine = event.metrics?.engine;
      return typeof engine === "string" ? engine : null;
    }
    seen += 1;
  }
  return null;
}

/**
 * Whether the run view should show the meta-harness climb instead of the tree.
 *
 * The lane that produced the newest versions decides while events are in hand;
 * a run without lane events falls back to the engine the result names, then to
 * the one the strategy asked for.
 */
export function isMetaHarnessRun(
  events: ProgressEvent[],
  engineUsed: string | null | undefined,
  strategyEngine: string | null | undefined,
): boolean {
  const fromLanes = engineOfLatestLane(events);
  if (fromLanes !== null) return fromLanes === META_HARNESS_ENGINE;
  return (engineUsed ?? strategyEngine ?? null) === META_HARNESS_ENGINE;
}

export interface CaseScore {
  trial: number;
  example_id: string;
  score: number;
  total: number;
}

export function extractCaseScores(events: ProgressEvent[]): CaseScore[] {
  const out: CaseScore[] = [];
  for (const event of events) {
    if (event.event !== CASE_SCORED_EVENT) continue;
    const m = event.metrics ?? {};
    if (typeof m.trial !== "number" || typeof m.score !== "number") continue;
    const exampleId =
      typeof m.example_id === "string"
        ? m.example_id
        : typeof m.example_id === "number"
          ? String(m.example_id)
          : null;
    if (exampleId === null) continue;
    out.push({
      trial: m.trial,
      example_id: exampleId,
      score: m.score,
      total: typeof m.total === "number" ? m.total : 0,
    });
  }
  return out;
}

export interface ClimbVersion {
  candidate: CandidateMetrics;
  index: number;
  score: number;
  // Best score among the versions before this one; null for the first.
  bestBefore: number | null;
  improved: boolean;
}

// A version still being scored: its cases fill in one by one until the
// candidate event completes it.
export interface PendingVersion {
  index: number;
  total: number;
  scores: Map<string, number>;
}

export interface ClimbModel {
  versions: ClimbVersion[];
  caseIds: string[];
  pending: PendingVersion | null;
  bestId: string | null;
}

function compareIds(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a.localeCompare(b);
}

/**
 * Turn the lane's versions into a climb: each version measured against the
 * best before it, plus the version currently being scored, if any.
 */
export function buildClimb(candidates: CandidateMetrics[], caseScores: CaseScore[]): ClimbModel {
  const sorted = [...candidates].sort((a, b) => compareIds(a.candidate_id, b.candidate_id));
  const versions: ClimbVersion[] = [];
  const caseIds = new Set<string>();
  let best: number | null = null;
  let bestId: string | null = null;
  let lastIndex = -1;
  for (const candidate of sorted) {
    const parsed = Number(candidate.candidate_id);
    const index = Number.isFinite(parsed) ? parsed : versions.length;
    const improved = best === null || candidate.score > best;
    versions.push({ candidate, index, score: candidate.score, bestBefore: best, improved });
    if (improved) {
      best = candidate.score;
      bestId = candidate.candidate_id;
    }
    lastIndex = Math.max(lastIndex, index);
    for (const entry of candidate.per_example) caseIds.add(entry.id);
  }

  let pendingIndex = -1;
  for (const scored of caseScores) {
    if (scored.trial > lastIndex) pendingIndex = Math.max(pendingIndex, scored.trial);
  }
  let pending: PendingVersion | null = null;
  if (pendingIndex >= 0) {
    pending = { index: pendingIndex, total: 0, scores: new Map() };
    for (const scored of caseScores) {
      if (scored.trial !== pendingIndex) continue;
      pending.scores.set(scored.example_id, scored.score);
      pending.total = Math.max(pending.total, scored.total);
      caseIds.add(scored.example_id);
    }
  }

  return { versions, caseIds: [...caseIds].sort(compareIds), pending, bestId };
}

export const CLIMB_LAYOUT = {
  nodeRadius: 22,
  ringThickness: 6,
  stepMin: 88,
  stepMax: 168,
  padStart: 64,
  padEnd: 44,
  padTop: 40,
  padBottom: 44,
  plotHeight: 280,
  tickCount: 5,
} as const;

export interface ClimbPoint {
  id: string;
  x: number;
  y: number;
  version: ClimbVersion;
}

export interface ClimbLayout {
  points: ClimbPoint[];
  pending: { x: number; y: number } | null;
  // The best score so far as a staircase: one riser per improving version.
  bestPath: Array<{ x: number; y: number }>;
  edges: Array<{ from: ClimbPoint; to: ClimbPoint }>;
  ticks: Array<{ value: number; y: number }>;
  domain: { min: number; max: number; unit: boolean };
  width: number;
  height: number;
}

export function meanOf(values: Iterable<number>): number | null {
  let sum = 0;
  let count = 0;
  for (const value of values) {
    sum += value;
    count += 1;
  }
  return count === 0 ? null : sum / count;
}

function scoreDomain(scores: number[]): ClimbLayout["domain"] {
  if (scores.length === 0) return { min: 0, max: 1, unit: true };
  const unit = scores.every((s) => s >= 0 && s <= 1);
  if (unit) return { min: 0, max: 1, unit: true };
  let min = Math.min(...scores);
  let max = Math.max(...scores);
  const pad = max > min ? (max - min) * 0.1 : Math.max(1, Math.abs(max) * 0.1);
  min -= pad;
  max += pad;
  return { min, max, unit: false };
}

/**
 * Place the climb on a version-by-score plane.
 *
 * Versions sit left to right in the order they were scored; the column pitch
 * stretches to fill the width on hand between ``stepMin`` and ``stepMax``.
 */
export function layoutClimb(
  model: ClimbModel,
  options: { availableWidth?: number; showPending?: boolean } = {},
): ClimbLayout {
  const L = CLIMB_LAYOUT;
  const pendingMean = model.pending === null ? null : meanOf(model.pending.scores.values());
  const showPending = options.showPending === true && model.pending !== null;
  const scores = model.versions.map((v) => v.score);
  if (showPending && pendingMean !== null) scores.push(pendingMean);
  const domain = scoreDomain(scores);
  const span = domain.max - domain.min;
  const yOf = (score: number): number =>
    L.padTop + L.plotHeight - ((score - domain.min) / span) * L.plotHeight;

  const columns = model.versions.length + (showPending ? 1 : 0);
  const available = options.availableWidth ?? 0;
  const step =
    columns <= 1
      ? L.stepMin
      : Math.max(
          L.stepMin,
          Math.min(L.stepMax, (available - L.padStart - L.padEnd) / (columns - 1)),
        );
  const xOf = (column: number): number => L.padStart + column * step;

  const points: ClimbPoint[] = model.versions.map((version, column) => ({
    id: version.candidate.candidate_id,
    x: xOf(column),
    y: yOf(version.score),
    version,
  }));
  const byId = new Map(points.map((p) => [p.id, p]));

  const bestPath: ClimbLayout["bestPath"] = [];
  let best: number | null = null;
  for (const point of points) {
    if (best !== null) bestPath.push({ x: point.x, y: yOf(best) });
    if (best === null || point.version.score > best) best = point.version.score;
    bestPath.push({ x: point.x, y: yOf(best) });
  }

  const edges: ClimbLayout["edges"] = [];
  for (const point of points) {
    const parentId = point.version.candidate.parent_id;
    if (parentId === null) continue;
    const parent = byId.get(parentId);
    if (parent !== undefined) edges.push({ from: parent, to: point });
  }

  // Until a case is scored the pending version rides at the score it is
  // rewriting, then settles on the mean of the cases scored so far.
  let pending: ClimbLayout["pending"] = null;
  if (showPending) {
    const y =
      pendingMean !== null
        ? yOf(pendingMean)
        : best !== null
          ? yOf(best)
          : yOf((domain.min + domain.max) / 2);
    pending = { x: xOf(columns - 1), y };
  }

  const ticks: ClimbLayout["ticks"] = [];
  for (let i = 0; i < L.tickCount; i += 1) {
    const value = domain.min + (span * i) / (L.tickCount - 1);
    ticks.push({ value, y: yOf(value) });
  }

  return {
    points,
    pending,
    bestPath,
    edges,
    ticks,
    domain,
    width: L.padStart + Math.max(0, columns - 1) * step + L.padEnd,
    height: L.padTop + L.plotHeight + L.padBottom,
  };
}
