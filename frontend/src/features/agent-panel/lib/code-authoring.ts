/**
 * The coding agent's own tool calls read as the rows its chat lists: the
 * files it deleted and each ``verify_code`` check. Pure, so the rows and the
 * tests read calls the same way.
 */

/** One edit the coding agent made to a workspace file. */
export interface AuthoringEdit {
  /** The file's workspace path: run.py, metric.py or an extra file. */
  file: string;
  before: string;
  after: string;
  ts: number;
}

/** One file the coding agent deleted from the workspace. */
export interface AuthoringDelete {
  file: string;
  ts: number;
}

/** One ``verify_code`` call: running, then passed or failed with each failing file's findings. */
export interface AuthoringCheck {
  id: string;
  ts: number;
  state: "running" | "passed" | "failed";
  /** The files that failed and what the check found in each; an empty path is the whole workspace. */
  failures: Array<{ path: string; errors: string[] }>;
}

type ToolCallLike = {
  id: string;
  tool: string;
  status: string;
  startedAt: number;
  path?: string;
  verification?: { ok: boolean; files: ReadonlyArray<{ path: string; ok: boolean; errors: string[] }> };
};

/**
 * Read the coding agent's ``delete_file`` and ``verify_code`` calls as rows.
 *
 * Args:
 *   messages: The coding agent's chat.
 *   since: When this tool call started; earlier calls' rows are left out.
 *
 * Returns:
 *   The files deleted and each check, oldest first.
 */
export function authoringToolRows(
  messages: ReadonlyArray<{ toolCalls?: readonly ToolCallLike[] }>,
  since: number,
): { deletes: AuthoringDelete[]; checks: AuthoringCheck[] } {
  const deletes: AuthoringDelete[] = [];
  const checks: AuthoringCheck[] = [];
  for (const call of messages.flatMap((m) => m.toolCalls ?? [])) {
    if (call.startedAt < since) continue;
    if (call.tool === "delete_file" && call.status === "done" && call.path) {
      deletes.push({ file: call.path, ts: call.startedAt });
    } else if (call.tool === "verify_code") {
      const result = call.verification;
      // A call that errored without a result is a failed check with nothing to list.
      const state =
        call.status === "running" || (!result && call.status !== "error")
          ? "running"
          : result?.ok
            ? "passed"
            : "failed";
      checks.push({
        id: call.id,
        ts: call.startedAt,
        state,
        failures:
          state === "failed"
            ? (result?.files ?? []).filter((f) => !f.ok).map((f) => ({ path: f.path, errors: [...f.errors] }))
            : [],
      });
    }
  }
  return { deletes, checks };
}
