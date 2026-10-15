/**
 * The coding agent's own verify_code verdict, kept with the exact files it
 * checked. While the workspace still holds those files, the IDE's results
 * strip shows it at once instead of waiting for a fresh sandboxed Check.
 */
import type { FileVerification } from "@/shared/types/unified-run";

/** A verify_code result and the workspace it was run on. */
export interface AgentVerdict {
  ok: boolean;
  files: FileVerification[];
  /** `workspaceKey` of the files verify_code saw. */
  key: string;
}

/**
 * One string that changes whenever any workspace file does.
 *
 * Args:
 *   runCode: run.py.
 *   metricCode: metric.py.
 *   files: The extra files by path.
 *
 * Returns:
 *   The workspace's identity, independent of the files' key order.
 */
export function workspaceKey(
  runCode: string,
  metricCode: string,
  files: Readonly<Record<string, string>>,
): string {
  const extra = Object.keys(files)
    .sort()
    .map((path) => [path, files[path]]);
  return JSON.stringify([runCode, metricCode, extra]);
}
