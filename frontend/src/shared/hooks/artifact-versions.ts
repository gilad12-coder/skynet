/** One saved version of an authored artifact (run code or metric). */
export interface ArtifactVersion {
  code: string;
  ts: number;
}

/**
 * Add a version to an artifact's history, unless it repeats the latest one.
 *
 * A seed lane lands its code when it finishes, and the turn's end reports the
 * same code again; keeping both would add a no-op version.
 *
 * Args:
 *   versions: The history so far, oldest first.
 *   code: The code to record.
 *   ts: When it landed, in ms.
 *
 * Returns:
 *   The history with the new version; the same array when nothing changed.
 */
export function appendVersion(
  versions: ArtifactVersion[],
  code: string,
  ts: number,
): ArtifactVersion[] {
  if (!code.trim() || versions[versions.length - 1]?.code === code) return versions;
  return [...versions, { code, ts }];
}
