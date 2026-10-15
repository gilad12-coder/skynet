/**
 * "Show this file" for the IDE: the coding agent's open_file calls and the
 * transcript rows that repeat them ask the workspace to open a file, and the
 * workspace opens it once the files it holds are current.
 */

/** One request to open a file; each is queued, so the same file can be asked for again. */
export interface IdeOpenRequest {
  path: string;
  /** 1-based; absent opens the file where it was. */
  line?: number;
}

/**
 * Resolve an open request against the workspace's files.
 *
 * Args:
 *   request: The file and line asked for.
 *   texts: Every workspace file, path to text.
 *
 * Returns:
 *   The file to open with its line clamped to the file, or null for a file the workspace does not hold.
 */
export function openTarget(
  request: IdeOpenRequest,
  texts: Readonly<Record<string, string>>,
): IdeOpenRequest | null {
  if (!Object.hasOwn(texts, request.path)) return null;
  const text = texts[request.path] ?? "";
  const line = request.line !== undefined && Number.isFinite(request.line) ? Math.floor(request.line) : 0;
  if (line < 1) return { path: request.path };
  return { path: request.path, line: Math.min(line, text.split("\n").length) };
}

/**
 * The queued requests not opened yet, resolved against the workspace, in the
 * order they were made. Two open_file calls in one stream chunk reach the
 * workspace in one render, so each must be kept, not just the last.
 *
 * Args:
 *   requests: Every request made so far, oldest first.
 *   handled: How many of them were already opened.
 *   texts: Every workspace file, path to text.
 *
 * Returns:
 *   The files to open now, in order; the last one ends up in front.
 */
export function pendingOpens(
  requests: readonly IdeOpenRequest[],
  handled: number,
  texts: Readonly<Record<string, string>>,
): IdeOpenRequest[] {
  return requests.slice(handled).flatMap((request) => openTarget(request, texts) ?? []);
}

/**
 * The first line where a file's text changed, for opening a file the agent wrote.
 *
 * Args:
 *   before: The text before the change ("" for a new file).
 *   after: The text after it.
 *
 * Returns:
 *   The 1-based first differing line, or undefined when nothing changed.
 */
export function firstChangedLine(before: string, after: string): number | undefined {
  if (before === after) return undefined;
  const a = before.split("\n");
  const b = after.split("\n");
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return Math.min(i, b.length - 1) + 1;
}
