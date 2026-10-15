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

/** A file to open: a workspace file, or (`inRepo`) a repository path still to look up in its tree. */
export interface IdeOpenTarget extends IdeOpenRequest {
  inRepo?: true;
}

/**
 * Clamp a requested line to a file's text.
 *
 * Args:
 *   line: The 1-based line asked for, if any.
 *   text: The file's text.
 *
 * Returns:
 *   The line, floored and at most the file's last line; undefined for none or a non-positive one.
 */
export function clampLine(line: number | undefined, text: string): number | undefined {
  const wanted = line !== undefined && Number.isFinite(line) ? Math.floor(line) : 0;
  return wanted < 1 ? undefined : Math.min(wanted, text.split("\n").length);
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
  const line = clampLine(request.line, texts[request.path] ?? "");
  return line ? { path: request.path, line } : { path: request.path };
}

/**
 * Resolve an open request for a repository file, once its text is read.
 *
 * Args:
 *   request: The repository-relative file and line asked for.
 *   folder: The explorer folder the repository shows under.
 *   text: The file's text, or null when it has none to show (binary, too large).
 *
 * Returns:
 *   The file's workspace path, with its line clamped to the text when there is one.
 */
export function repoOpenTarget(request: IdeOpenRequest, folder: string, text: string | null): IdeOpenRequest {
  const path = `${folder}/${request.path}`;
  const line = text === null ? undefined : clampLine(request.line, text);
  return line ? { path, line } : { path };
}

/**
 * The queued requests not opened yet, resolved against the workspace, in the
 * order they were made. Two open_file calls in one stream chunk reach the
 * workspace in one render, so each must be kept, not just the last. A
 * workspace file wins over a repository file of the same path, as it does
 * for the agent.
 *
 * Args:
 *   requests: Every request made so far, oldest first.
 *   handled: How many of them were already opened.
 *   texts: Every workspace file, path to text.
 *   hasRepo: The run shows a repository, so other paths may be its files.
 *
 * Returns:
 *   The files to open now, in order; the last one ends up in front.
 */
export function pendingOpens(
  requests: readonly IdeOpenRequest[],
  handled: number,
  texts: Readonly<Record<string, string>>,
  hasRepo = false,
): IdeOpenTarget[] {
  return requests
    .slice(handled)
    .flatMap((request) => openTarget(request, texts) ?? (hasRepo ? [{ ...request, inRepo: true as const }] : []));
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
