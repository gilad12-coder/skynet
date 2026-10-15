/**
 * Splits a contract check's results between the workspace's files, so each
 * failure shows next to the code it is about.
 */
import type { ContractCheckItem, ContractCheckResponse } from "@/shared/types/unified-run";

// Same names as wizard-v2's RUN_FILE / METRIC_FILE; kept local so this module
// loads in the plain-module tests without the app's path aliases.
const RUN_FILE = "run.py";
const METRIC_FILE = "metric.py";

/** The editor console's shape (`ValidationResult` in the shared code editor). */
export interface ContractConsole {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// A traceback frame as the harness writes it: `File "helpers.py", line 3`.
const FRAME = /File "([^"]+)", line \d+/g;
// The harness compiles run.py under this name, so its frames carry it.
const RUN_FRAME = "<run_code>";

/**
 * Which file a check item is about. A metric item is metric.py; a file item
 * names its file; a run failure whose traceback ends in one of `extraPaths`
 * is that file; everything else is run.py.
 */
export function checkFile(
  item: Pick<ContractCheckItem, "key" | "detail" | "message_params">,
  extraPaths: readonly string[] = [],
): string {
  if (item.key.startsWith("metric.")) return METRIC_FILE;
  const named = item.message_params?.path;
  if (item.key === "workspace.files" && typeof named === "string" && named) return named;
  if (item.key === "workspace.run" && item.detail && extraPaths.length > 0) {
    let last: string | null = null;
    for (const match of item.detail.matchAll(FRAME)) {
      const name = match[1] === RUN_FRAME ? RUN_FILE : (match[1] ?? "");
      if (name === RUN_FILE || extraPaths.includes(name)) last = name;
    }
    if (last) return last;
  }
  return RUN_FILE;
}

/**
 * The console one file shows for a check: its failed items and lint errors as
 * errors, its lint warnings as warnings.
 *
 * `line` renders one item (localized message plus detail); it is passed in
 * because the message catalog cannot load in the plain-module tests.
 */
export function contractConsole(
  result: ContractCheckResponse | null,
  path: string,
  line: (item: ContractCheckItem) => string,
  extraPaths: readonly string[] = [],
): ContractConsole | null {
  if (!result) return null;
  const lint = result.files?.find((file) => file.path === path);
  const errors = [
    ...result.checks
      .filter((item) => item.status === "failed" && checkFile(item, extraPaths) === path)
      .map(line),
    ...(lint?.errors ?? []),
  ];
  return { valid: errors.length === 0, errors, warnings: [...(lint?.warnings ?? [])] };
}
