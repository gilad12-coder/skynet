/**
 * Pure rules for a turn's history header ("Working for 3s" / "Worked for 9s")
 * and the thinking rows under it, kept apart so the tests pin them.
 */

interface Timed {
  startedAt: number | null;
  endedAt: number | null;
}

interface TimedCall {
  call: { startedAt: number; endedAt: number | null };
}

/**
 * The thinking segments a turn shows as rows: only those with reasoning text.
 *
 * A segment opens before the model sends anything, and a model that streams
 * no reasoning never fills it. Shown, it was a "Thinking" row that vanished
 * a second later and took the turn's header with it.
 *
 * Args:
 *   segments: The turn's thinking segments, oldest first.
 *
 * Returns:
 *   The segments with reasoning, in order.
 */
export function visibleThinking<T extends { reasoning: string }>(segments: readonly T[]): T[] {
  return segments.filter((s) => s.reasoning.length > 0);
}

/**
 * When the turn started: its earliest thinking segment or tool call.
 *
 * Args:
 *   thinking: Every thinking segment of the turn, shown or not.
 *   steps: The turn's tool calls.
 *
 * Returns:
 *   The earliest start in ms, or null when nothing has started.
 */
export function turnStart(thinking: readonly Timed[], steps: readonly TimedCall[]): number | null {
  const starts = steps.map(({ call }) => call.startedAt).filter(Boolean);
  for (const t of thinking) if (t.startedAt) starts.push(t.startedAt);
  return starts.length ? Math.min(...starts) : null;
}

/**
 * Keep the earliest start ever seen, so the live timer never runs backwards.
 *
 * A start can drop out of the turn (a segment that never got reasoning), and
 * recomputing from what is left moved the start later: "Working for 2s" then
 * "Working for 1s".
 *
 * Args:
 *   seen: The earliest start kept so far.
 *   next: The start computed now.
 *
 * Returns:
 *   The earlier of the two, ignoring nulls.
 */
export function earliestStart(seen: number | null, next: number | null): number | null {
  if (seen === null) return next;
  if (next === null) return seen;
  return Math.min(seen, next);
}

/**
 * How long a finished turn took, from its start to the last thing that ended.
 *
 * Args:
 *   start: The turn's start in ms, or null.
 *   thinking: The turn's thinking segments.
 *   steps: The turn's tool calls; a card's own work (the coding tool) ends
 *     after the turn's reply, and counts up to its end.
 *   durationMs: The backend-measured duration of the chat turn, when known.
 *
 * Returns:
 *   The longer of the measured duration and the span the history covers.
 */
export function finishedTurnMs(
  start: number | null,
  thinking: readonly Timed[],
  steps: readonly TimedCall[],
  durationMs?: number | null,
): number {
  let span = 0;
  if (start !== null) {
    const ends = steps.map(({ call }) => call.endedAt ?? call.startedAt);
    for (const t of thinking) if (t.endedAt) ends.push(t.endedAt);
    span = Math.max(0, Math.max(start, ...ends) - start);
  }
  return Math.max(durationMs ?? 0, span);
}
