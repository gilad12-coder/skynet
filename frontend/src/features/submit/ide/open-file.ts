/**
 * "Show this file" for the IDE: the coding agent's open_file calls and the
 * transcript rows that repeat them ask the workspace to open a file, and the
 * workspace opens it once the files it holds are current.
 */

/** One request to open a file; each request is a new object, so the same file can be asked for again. */
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
