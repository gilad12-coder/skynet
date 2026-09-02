import type { ParsedDataset } from "@/shared/lib/parse-dataset";
import type { SplitFractions } from "@/shared/types/api";
import type { ColumnRole } from "../constants";

/**
 * Recipe-independent view of a stored optimization payload, shared by both
 * wizards' `?clone=` hydration. The recipe picker lets a run be cloned into
 * either wizard, so each must read the other's rows: a Program (DSPy) run keeps
 * them under `dataset` (+ `column_order`, `column_mapping`), an Anything
 * (black-box) run under `cases`.
 */
export type ClonePayload = Record<string, unknown>;

export type CloneRecipe = "program" | "anything";

/** Which wizard authored a stored payload, from its job's optimization type. */
export function cloneSourceRecipe(optimizationType: string): CloneRecipe {
  return optimizationType === "blackbox" ? "anything" : "program";
}

export interface CloneBasics {
  name: string | null;
  description: string | null;
  isPrivate: boolean | null;
  split: Partial<SplitFractions> | null;
  shuffle: boolean | null;
  seed: number | null;
}

/**
 * Reads the fields every recipe stores the same way. The job row's display
 * name (`jobName`) wins over the payload's, matching what the run view shows.
 */
export function cloneBasics(payload: ClonePayload, jobName?: string | null): CloneBasics {
  const name = jobName || payload.name;
  const split = payload.split_fractions as Partial<SplitFractions> | null | undefined;
  return {
    name: name ? String(name) : null,
    description: payload.description ? String(payload.description) : null,
    isPrivate: payload.is_private == null ? null : Boolean(payload.is_private),
    split: split && typeof split === "object" ? split : null,
    shuffle: payload.shuffle == null ? null : Boolean(payload.shuffle),
    seed: payload.seed == null ? null : Number(payload.seed),
  };
}

const isRow = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * The stored rows of either recipe as a wizard dataset, or null when the
 * payload carries none. Restores the submitted `column_order` when present
 * (the rows' own key order is scrambled by JSONB), appending any column the
 * saved order didn't cover.
 */
export function cloneRows(payload: ClonePayload): ParsedDataset | null {
  const stored = Array.isArray(payload.dataset)
    ? payload.dataset
    : Array.isArray(payload.cases)
      ? payload.cases
      : [];
  const rows = stored.filter(isRow);
  const first = rows[0];
  if (!first) return null;
  const rowKeys = Object.keys(first);
  const savedOrder = Array.isArray(payload.column_order)
    ? payload.column_order.filter(
        (column): column is string => typeof column === "string" && rowKeys.includes(column),
      )
    : [];
  const columns =
    savedOrder.length > 0
      ? [...savedOrder, ...rowKeys.filter((column) => !savedOrder.includes(column))]
      : rowKeys;
  return { columns, rows, rowCount: rows.length };
}

/**
 * Column roles for cloned rows. `column_mapping` persists only inputs and
 * outputs — "ignore" is implicit — so every column is seeded to ignore and the
 * mapped roles overlaid, exactly like an upload followed by role picks. Rows
 * from an Anything run carry no mapping and come back all-ignore: the Cases
 * step then asks for the input/output picks the Program recipe needs.
 */
export function cloneColumnRoles(
  payload: ClonePayload,
  columns: readonly string[],
): Record<string, ColumnRole> {
  const roles: Record<string, ColumnRole> = {};
  for (const column of columns) roles[column] = "ignore";
  const mapping = payload.column_mapping as
    | { inputs?: Record<string, unknown>; outputs?: Record<string, unknown> }
    | null
    | undefined;
  for (const column of Object.keys(mapping?.inputs ?? {})) roles[column] = "input";
  for (const column of Object.keys(mapping?.outputs ?? {})) roles[column] = "output";
  return roles;
}
