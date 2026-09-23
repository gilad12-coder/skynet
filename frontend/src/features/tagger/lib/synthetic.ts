/** Limits mirrored from the backend's `/tagging-sessions/synthesize` route. */
export const SYNTHETIC_DEFAULT_ROWS = 30;
export const SYNTHETIC_MAX_ROWS = 200;
export const SYNTHETIC_MAX_COLUMNS = 6;
const COLUMN_CHARS = 60;
const SOURCE_NAME_CHARS = 60;

/** "text, channel,, text" → ["text", "channel"]: comma/newline split, trimmed, deduped, capped. */
export function parseSyntheticColumns(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(/[,\n]/)) {
    const name = part.trim().slice(0, COLUMN_CHARS);
    if (name && !out.includes(name)) out.push(name);
  }
  return out.slice(0, SYNTHETIC_MAX_COLUMNS);
}

/** Coerce the row-count field to a whole number inside the route's limits. */
export function clampSyntheticRows(value: number): number {
  if (!Number.isFinite(value)) return SYNTHETIC_DEFAULT_ROWS;
  return Math.min(SYNTHETIC_MAX_ROWS, Math.max(1, Math.round(value)));
}

/** First line of the brief, whitespace-collapsed and capped: the session's source name. */
export function syntheticSourceName(brief: string): string {
  const line =
    brief
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? "";
  const collapsed = line.replace(/\s+/g, " ");
  if (collapsed.length <= SOURCE_NAME_CHARS) return collapsed;
  return `${collapsed.slice(0, SOURCE_NAME_CHARS - 1).trimEnd()}…`;
}
