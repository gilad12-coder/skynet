/**
 * One unbroken stretch of the model's reasoning within a turn. A tool call or
 * prose ends it, and reasoning after that opens a new one, so the transcript
 * shows "Thought for 3s", the tool, then a second "Thought for 2s" row.
 */
export interface ThinkingSegment {
  reasoning: string;
  startedAt: number | null;
  /** Null while the segment is still open. */
  endedAt: number | null;
  /** How many of the turn's tool calls had started when this segment began. */
  toolsBefore: number;
}

function openLast(segments: readonly ThinkingSegment[]): ThinkingSegment | null {
  const last = segments[segments.length - 1];
  return last && last.endedAt === null ? last : null;
}

/**
 * Open an empty segment, the "Thinking" row shown before any reasoning lands.
 *
 * Args:
 *   segments: The turn's segments so far.
 *   now: The current time in ms.
 *   toolCount: How many tool calls the turn has started.
 *
 * Returns:
 *   The segments with an open one at the end; unchanged if one is open already.
 */
export function startThinking(
  segments: readonly ThinkingSegment[],
  now: number,
  toolCount: number,
): ThinkingSegment[] {
  if (openLast(segments)) return segments.slice();
  return [...segments, { reasoning: "", startedAt: now, endedAt: null, toolsBefore: toolCount }];
}

/**
 * Add a reasoning delta to the open segment, or start a new segment with it.
 *
 * Args:
 *   segments: The turn's segments so far.
 *   chunk: The reasoning delta.
 *   now: The current time in ms.
 *   toolCount: How many tool calls the turn has started.
 *
 * Returns:
 *   The updated segments.
 */
export function appendReasoning(
  segments: readonly ThinkingSegment[],
  chunk: string,
  now: number,
  toolCount: number,
): ThinkingSegment[] {
  const open = openLast(segments);
  if (!open) {
    return [...segments, { reasoning: chunk, startedAt: now, endedAt: null, toolsBefore: toolCount }];
  }
  const next = segments.slice();
  // The clock of an empty placeholder starts at the first token, not at send.
  next[next.length - 1] = {
    ...open,
    reasoning: open.reasoning + chunk,
    startedAt: open.reasoning ? open.startedAt : now,
  };
  return next;
}

/**
 * Close the open segment, as a tool call, prose or the turn's end does. An
 * open segment that never got any reasoning is dropped instead.
 *
 * Args:
 *   segments: The turn's segments so far.
 *   now: The current time in ms.
 *
 * Returns:
 *   The updated segments; the same array when nothing was open.
 */
export function closeThinking(
  segments: readonly ThinkingSegment[],
  now: number,
): readonly ThinkingSegment[] {
  const open = openLast(segments);
  if (!open) return segments;
  if (!open.reasoning) return segments.slice(0, -1);
  const next = segments.slice();
  next[next.length - 1] = { ...open, endedAt: now };
  return next;
}

/**
 * Reopen the last segment when the prose that closed it was taken back and no
 * tool ran since, so the reasoning carries on in the same row.
 *
 * Args:
 *   segments: The turn's segments so far.
 *   toolCount: How many tool calls the turn has started.
 *
 * Returns:
 *   The updated segments; the same array when there is nothing to reopen.
 */
export function reopenThinking(
  segments: readonly ThinkingSegment[],
  toolCount: number,
): readonly ThinkingSegment[] {
  const last = segments[segments.length - 1];
  if (!last || last.endedAt === null || last.toolsBefore !== toolCount) return segments;
  const next = segments.slice();
  next[next.length - 1] = { ...last, endedAt: null };
  return next;
}

export type ActivityPiece<S, T> = { kind: "thinking"; segment: S } | { kind: "steps"; steps: T[] };

/**
 * Lay a turn's thinking segments and tool steps out in the order they ran:
 * each segment goes before the first step that started after it, and the
 * steps between two segments stay together as one burst.
 *
 * Args:
 *   segments: The turn's thinking segments, oldest first.
 *   steps: The steps to show, each with its index among the turn's tool calls.
 *
 * Returns:
 *   Thinking rows and step bursts, interleaved.
 */
export function interleaveThinking<S extends { toolsBefore: number }, T extends { index: number }>(
  segments: readonly S[],
  steps: readonly T[],
): Array<ActivityPiece<S, T>> {
  const out: Array<ActivityPiece<S, T>> = [];
  let burst: T[] = [];
  const flush = () => {
    if (burst.length) out.push({ kind: "steps", steps: burst });
    burst = [];
  };
  let s = 0;
  for (const step of steps) {
    while (s < segments.length && (segments[s]?.toolsBefore ?? 0) <= step.index) {
      flush();
      out.push({ kind: "thinking", segment: segments[s] as S });
      s++;
    }
    burst.push(step);
  }
  flush();
  for (; s < segments.length; s++) out.push({ kind: "thinking", segment: segments[s] as S });
  return out;
}
