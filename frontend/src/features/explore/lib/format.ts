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

import { msg } from "@/shared/lib/messages";
import { getActiveIntlLocale } from "@/shared/lib/runtime-locale";
import type { BlackboxEngineId } from "@/shared/types/api";

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

/**
 * Exact calendar date of a run, in the active UI locale but always on the
 * Gregorian calendar. Medium style with the year always shown, e.g.
 * "Sep 12, 2026". Returns "—" for missing/unparseable input.
 *
 * The `gregory` calendar is pinned deliberately: some locales (Persian, and
 * a few Arabic regions) default `Intl` to a non-Gregorian calendar, so
 * without it the same run would show a different date per locale.
 */
export function formatExactDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(getActiveIntlLocale(), {
    dateStyle: "medium",
    calendar: "gregory",
  });
}
