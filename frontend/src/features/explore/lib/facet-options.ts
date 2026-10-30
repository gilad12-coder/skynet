/**
 * Pure helpers behind the explore filter pickers' value lists.
 *
 * A filter dimension can hold thousands of distinct values (every model id
 * ever optimized against), so a picker never lists one in full. Each
 * dimension shows its busiest values up to a small cap, ranked by the number
 * of runs each would leave alongside the other active filters, and reports
 * how many distinct values exist so the user knows to search for the rest.
 * The backend does this ranking; these helpers lay out the picker rows.
 */

import type { FacetOption } from "@/shared/lib/api";

/** Values shown per dimension before the user has to search or ask for more. */
export const FACET_LIMIT = 8;
/** Values added per "Show more"; the backend caps a single list at `FACET_LIMIT_MAX`. */
export const FACET_LIMIT_STEP = 24;
export const FACET_LIMIT_MAX = 50;

export interface PickerRow {
  value: string;
  /** Null when the value is selected but fell outside the ranked slice, so its count is unknown. */
  count: number | null;
  checked: boolean;
}

/**
 * The rows a picker lists: the selected values pinned first (so a choice
 * stays visible and removable even once it drops out of the top ranks or
 * stops matching the search), then the ranked options that are not selected.
 */
export function pickerRows(options: FacetOption[], selected: string[]): PickerRow[] {
  const counts = new Map(options.map((o) => [o.value, o.count]));
  const pinned = selected.map((value) => ({ value, count: counts.get(value) ?? null, checked: true }));
  const rest = options
    .filter((o) => !selected.includes(o.value))
    .map((o) => ({ value: o.value, count: o.count, checked: false }));
  return [...pinned, ...rest];
}
