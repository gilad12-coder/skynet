/**
 * Pure formatters for the explore slice.
 *
 * DSPy scores (run / grid search) are on the canonical 0–100 percentage
 * scale — the scale `dspy.Evaluate` reports and the one every job persists
 * after the metric normalization migration (see
 * `backend/service_gateway/embedding_pipeline._extract_scores`). Formatters
 * append "%" and never rescale: a value is already in percentage points, so
 * a 0.3-point gain reads "+0.3%", not "+30%".
 *
 * Black-box ("optimize anything") scores are whatever the user's scorer
 * returned — no unit, no fixed range — so they render verbatim, the same way
 * the optimization page shows them.
 */

import { formatBlackboxDelta, formatBlackboxScore } from "@/shared/lib/formatters";
import { msg } from "@/shared/lib/messages";
import { getActiveIntlLocale } from "@/shared/lib/runtime-locale";
import type { BlackboxEngineId, OptimizationType } from "@/shared/types/api";

export type GainBadge = {
  text: string;
  kind: "positive" | "negative" | "neutral";
};

const RAW_SCALE_TYPE: OptimizationType = "blackbox";

function isRawScale(type: string | null | undefined): boolean {
  return type === RAW_SCALE_TYPE;
}

export function formatMetric(
  value: number | null | undefined,
  type?: string | null,
): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (isRawScale(type)) return formatBlackboxScore(value);
  return `${value.toFixed(1)}%`;
}

export function formatGain(
  baseline: number | null | undefined,
  optimized: number | null | undefined,
  type?: string | null,
): GainBadge | null {
  if (baseline == null || optimized == null) return null;
  if (!Number.isFinite(baseline) || !Number.isFinite(optimized)) return null;
  const gain = optimized - baseline;
  if (isRawScale(type)) {
    // Scorer deltas are compared after the same 4-decimal rounding the score
    // itself gets, so "0.5075 vs 0.5075" never shows a phantom "+0".
    const rounded = Number(gain.toFixed(4)) + 0;
    if (rounded === 0) return { text: "0", kind: "neutral" };
    return { text: formatBlackboxDelta(rounded), kind: rounded > 0 ? "positive" : "negative" };
  }
  if (Math.abs(gain) < 0.05) return { text: "0.0%", kind: "neutral" };
  if (gain > 0) return { text: `+${gain.toFixed(1)}%`, kind: "positive" };
  return { text: `${gain.toFixed(1)}%`, kind: "negative" };
}

// Engine ids are what the backend indexes for black-box runs (and what DSPy
// runs store for their optimizer, lowercased), so one map labels both. The
// labels mirror `GET /blackbox/engines`; anything unknown passes through.
const ENGINE_LABELS: Record<BlackboxEngineId, string> = {
  gepa: "GEPA",
  best_of_n: "Best-of-N",
  autoresearch: "AutoResearch",
  meta_harness: "Meta-Harness",
  autosaddler: "AutoSaddler",
};

/**
 * Human label for an optimizer / engine identifier as stored in the corpus.
 * "auto" is the strategy a black-box run was submitted with before it picked
 * an engine, so it reads as the same "Auto" the submit wizard shows.
 */
export function engineDisplayName(raw: string | null | undefined): string {
  if (!raw) return "";
  const key = raw.trim().toLowerCase();
  if (key === "auto") return msg("submit.blackbox.strategy.auto");
  return (ENGINE_LABELS as Record<string, string | undefined>)[key] ?? raw;
}

// Constructing Intl.RelativeTimeFormat is expensive (locale data + ICU
// pattern parse). Cache one instance per locale tag so every row reuses it.
const RTF_CACHE = new Map<string, Intl.RelativeTimeFormat>();

function relativeTimeFmt(tag: string): Intl.RelativeTimeFormat {
  let fmt = RTF_CACHE.get(tag);
  if (!fmt) {
    fmt = new Intl.RelativeTimeFormat(tag, { numeric: "auto" });
    RTF_CACHE.set(tag, fmt);
  }
  return fmt;
}

/**
 * Locale-aware relative time (now / yesterday / N days ago / last week) that
 * falls back to a short absolute date for items older than a month so the
 * row metadata never balloons. Returns "—" for missing/unparseable input.
 *
 * Uses Intl.RelativeTimeFormat with `numeric: "auto"` which already knows each
 * locale's special forms (English "yesterday", Hebrew dual "two days") so we
 * don't reinvent the pluralization table. Both the relative formatter and the
 * absolute fallback follow the active UI locale.
 *
 * Future timestamps (server clock ahead of client) are clamped to "now"
 * rather than rendering "in N minutes" — a job's `created_at` should never
 * be in the future from the reader's perspective. Unit selection uses
 * `Math.floor` (completed units, matching date-fns convention) so
 * something 6h59m old reads as "6 hours ago", not "7" that then races
 * the day boundary.
 */
export function formatRelativeDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const tag = getActiveIntlLocale();
  const rtf = relativeTimeFmt(tag);
  const diffMs = Math.max(0, Date.now() - d.getTime());
  const minutes = Math.floor(diffMs / 60_000);
  const hours = Math.floor(diffMs / 3_600_000);
  const days = Math.floor(diffMs / 86_400_000);
  if (minutes < 1) return msg("explore.relative.now");
  if (minutes < 60) return rtf.format(-minutes, "minute");
  if (hours < 24) return rtf.format(-hours, "hour");
  if (days < 7) return rtf.format(-days, "day");
  if (days < 30) return rtf.format(-Math.floor(days / 7), "week");
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(tag, {
    day: "numeric",
    month: "long",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}
