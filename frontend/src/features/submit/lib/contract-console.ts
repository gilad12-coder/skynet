/**
 * Splits a contract check's results between the two editors and the sample
 * rows, so each failure shows next to the code or the sample it is about.
 */
import type {
  ContractCheckItem,
  ContractCheckResponse,
  ContractSample,
} from "@/shared/types/unified-run";

export type ContractEditor = "run" | "metric";

/** The editor console's shape (`ValidationResult` in the shared code editor). */
export interface ContractConsole {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/** Which editor's code a check item is about. */
export function checkEditor(item: Pick<ContractCheckItem, "key">): ContractEditor {
  return item.key.startsWith("metric.") ? "metric" : "run";
}

/**
 * The console one editor shows for a check: its failed items as errors.
 *
 * `line` renders one item (localized message plus detail); it is passed in
 * because the message catalog cannot load in the plain-module tests.
 */
export function contractConsole(
  result: ContractCheckResponse | null,
  editor: ContractEditor,
  line: (item: ContractCheckItem) => string,
): ContractConsole | null {
  if (!result) return null;
  const errors = result.checks
    .filter((item) => item.status === "failed" && checkEditor(item) === editor)
    .map(line);
  return { valid: errors.length === 0, errors, warnings: [] };
}

export interface ContractSampleRow {
  sample: ContractSample;
  /** The failed checks on this sample, shown inline in its row. */
  failures: ContractCheckItem[];
}

/** Each scored sample with its failed checks. */
export function contractSampleRows(result: ContractCheckResponse | null): ContractSampleRow[] {
  if (!result) return [];
  return result.samples.map((sample) => ({
    sample,
    failures: result.checks.filter(
      (item) => item.status === "failed" && item.sample_index === sample.index,
    ),
  }));
}

/** The checks about the code as a whole, before any sample ran. */
export function contractStaticChecks(result: ContractCheckResponse | null): ContractCheckItem[] {
  return result?.checks.filter((item) => item.sample_index == null) ?? [];
}
