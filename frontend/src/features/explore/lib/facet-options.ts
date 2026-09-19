/**
 * Pure helpers behind the explore filter drawer's option lists.
 *
 * The drawer follows the classic faceted-navigation contract: every option
 * carries the number of runs it would leave alongside the other active
 * filters, and that count decides how the option is presented — greyed out
 * at zero, promoted into the collapsed view when a section is long. The
 * presentation is chosen per section from its cardinality alone: a handful
 * of values (run types, DSPy modules) is shown in full, a long open-ended
 * list (models) collapses to its busiest values until expanded.
 */

import type { FacetOption } from "@/shared/lib/api";

/** Sections with more options than this collapse to their busiest values. */
export const COLLAPSE_LIMIT = 8;

export function isCollapsible(options: FacetOption[]): boolean {
  return options.length > COLLAPSE_LIMIT;
}

/**
 * The options a section renders right now.
 *
 * A search query wins over everything and matches on the raw value or its
 * display label. Otherwise short and expanded sections show every option in
 * the order given (the caller keeps them alphabetical so rows never jump
 * when counts change); a collapsed long section shows its selected values
 * first, then the busiest of the rest up to the collapse limit.
 */
export function visibleOptions(
  options: FacetOption[],
  selected: string[],
  opts: { expanded: boolean; query: string; labelOf: (value: string) => string },
): FacetOption[] {
  const needle = opts.query.trim().toLowerCase();
  if (needle) {
    return options.filter(
      (o) =>
        o.value.toLowerCase().includes(needle) ||
        opts.labelOf(o.value).toLowerCase().includes(needle),
    );
  }
  if (opts.expanded || !isCollapsible(options)) return options;
  const selectedSet = new Set(selected);
  const pinned = options.filter((o) => selectedSet.has(o.value));
  const rest = options.filter((o) => !selectedSet.has(o.value)).sort((a, b) => b.count - a.count);
  return [...pinned, ...rest.slice(0, Math.max(0, COLLAPSE_LIMIT - pinned.length))];
}

/** True when the other active filters have ruled out every value in the section. */
export function isExhausted(options: FacetOption[]): boolean {
  return options.length > 0 && options.every((o) => o.count === 0);
}

/**
 * Facet options derived client-side by counting occurrences — the tutorial's
 * demo corpus has no backend scope to ask, so its counts are plain totals
 * rather than contextual ones. Empty and missing values are skipped.
 */
export function countOccurrences(values: ReadonlyArray<string | null | undefined>): FacetOption[] {
  const counts = new Map<string, number>();
  for (const v of values) {
    if (typeof v !== "string" || v.length === 0) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return Array.from(counts, ([value, count]) => ({ value, count })).sort((a, b) =>
    a.value.localeCompare(b.value),
  );
}
