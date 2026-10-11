/**
 * Pure helpers for the wizard v2 Inputs step: turning table rows or a typed
 * input into unified cases, and previewing how many cases the server will
 * hold out for the final score.
 */
import type { SplitFractions } from "@/shared/types/api";
import {
  MIN_PAIRS_FOR_HELD_OUT,
  type DataMode,
  type UnifiedCase,
} from "@/shared/types/unified-run";

import { splitExampleCounts } from "./split-example-counts";

/** The field a typed, unstructured input is stored under. */
export const TYPED_INPUT_FIELD = "input";

export type Row = Record<string, unknown>;

export interface HeldOutCounts {
  train: number;
  val: number;
  test: number;
  /** Whether any case is kept away from the optimizer for the final score. */
  heldOut: boolean;
}

/**
 * Build pair cases from table rows. The expected value is keyed by its column
 * name, because DSPy metrics read `gold.<output field>`.
 */
export function rowsToCases(
  rows: readonly Row[],
  inputFields: readonly string[],
  expectedField: string | null,
): UnifiedCase[] {
  return rows.map((row) => {
    const input: Row = {};
    for (const field of inputFields) {
      if (field !== expectedField) input[field] = row[field];
    }
    return expectedField ? { input, expected: { [expectedField]: row[expectedField] } } : { input };
  });
}

/** The table rows a set of cases came from, as far as the cases still carry them. */
export function casesToRows(cases: readonly UnifiedCase[]): Row[] {
  return cases.map((c) => {
    const expected =
      c.expected !== null && typeof c.expected === "object" && !Array.isArray(c.expected)
        ? (c.expected as Row)
        : {};
    return { ...c.input, ...expected };
  });
}

/** One case for single-input mode. */
export function singleInputCase(input: Row): UnifiedCase {
  return { input: { ...input } };
}

/**
 * Read a typed or pasted input: a JSON object keeps its fields, anything else
 * becomes one text field.
 */
export function parseTypedInput(text: string): Row {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Row;
      }
    } catch {
      // Not JSON after all; it is plain text.
    }
  }
  return { [TYPED_INPUT_FIELD]: text };
}

/** Every column except the expected one, in table order. */
export function defaultInputFields(columns: readonly string[], expectedField: string | null): string[] {
  return columns.filter((c) => c !== expectedField);
}

/**
 * How the server will split the cases (`unified/split.py`): single mode scores
 * its one case everywhere, and pairs below MIN_PAIRS_FOR_HELD_OUT keep no test
 * cases, sharing train and validation in their own proportion.
 */
export function heldOutCounts(
  total: number,
  split: SplitFractions,
  mode: DataMode | null,
): HeldOutCounts {
  if (mode !== "pairs" || total <= 0) {
    return { train: total, val: 0, test: 0, heldOut: false };
  }
  if (total < MIN_PAIRS_FOR_HELD_OUT) {
    const kept = split.train + split.val;
    const train = kept > 0 ? split.train / kept : 1;
    const counts = splitExampleCounts(total, { train, val: 1 - train, test: 0 });
    return { ...counts, test: 0, heldOut: false };
  }
  const counts = splitExampleCounts(total, split);
  return { ...counts, heldOut: counts.test > 0 };
}

/** Sum of the split fractions, rounded the way the split editor shows it. */
export function splitSum(split: SplitFractions): number {
  return Math.round((split.train + split.val + split.test) * 100) / 100;
}

export interface InputsCheck {
  mode: DataMode | null;
  caseCount: number;
  inputFields: readonly string[];
  expectedField: string | null;
  split: SplitFractions;
}

/**
 * The i18n key of what keeps the Inputs step from being confirmed, or null
 * when it can be.
 */
export function inputsIssue(s: InputsCheck): string | null {
  if (s.caseCount === 0) return "submit.v2.inputs.issue.no_data";
  if (s.mode === null) return "submit.v2.inputs.issue.no_mode";
  if (s.mode === "single") {
    return s.caseCount === 1 ? null : "submit.v2.inputs.issue.single_needs_one";
  }
  if (s.caseCount < 2) return "submit.v2.inputs.issue.pairs_need_two";
  if (s.inputFields.filter((f) => f !== s.expectedField).length === 0) {
    return "submit.v2.inputs.issue.no_input_fields";
  }
  if (splitSum(s.split) !== 1) return "submit.v2.inputs.issue.split_sum";
  return null;
}
