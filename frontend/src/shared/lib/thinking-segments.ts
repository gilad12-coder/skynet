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
  /** One line on what the segment worked out, written once it closed. */
  summary?: string;
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
 *   since: When the turn's previous event (a tool call or the last
 *     segment) ended, in ms; null when there was none.
 *
 * Returns:
 *   The updated segments.
 */
export function appendReasoning(
  segments: readonly ThinkingSegment[],
  chunk: string,
  now: number,
  toolCount: number,
  since: number | null = null,
): ThinkingSegment[] {
  const open = openLast(segments);
  if (!open) {
    // The model starts thinking when the previous event ends, not when its
    // reasoning reaches us: providers often send it in one burst right before
    // the next call, which made every later segment read "Thought for 0.0s".
    const startedAt = since !== null && since < now ? since : now;
    return [...segments, { reasoning: chunk, startedAt, endedAt: null, toolsBefore: toolCount }];
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

/**
 * Put a summary on the turn's ``index``-th segment that got reasoning. A turn
 * a steer split runs over several messages; the count spans all of them, as
 * the backend's does.
 *
 * Args:
 *   messages: The chat's messages.
 *   from: Index of the turn's first message.
 *   index: The segment's position among the turn's segments with reasoning.
 *   summary: The one-line summary.
 *
 * Returns:
 *   The updated messages; the same array when no such segment exists.
 */
export function summarizeThinking<M extends { thinkingSegments?: readonly ThinkingSegment[] }>(
  messages: M[],
  from: number,
  index: number,
  summary: string,
): M[] {
  let seen = 0;
  for (let m = Math.max(0, from); m < messages.length; m++) {
    const message = messages[m] as M;
    const segments = message.thinkingSegments ?? [];
    for (let s = 0; s < segments.length; s++) {
      if (!segments[s]?.reasoning) continue;
      if (seen++ !== index) continue;
      const nextSegments = segments.slice();
      nextSegments[s] = { ...(segments[s] as ThinkingSegment), summary };
      const next = messages.slice();
      next[m] = { ...message, thinkingSegments: nextSegments };
      return next;
    }
  }
  return messages;
}

/**
 * When the turn's latest event ended: the last tool call to finish (or start,
 * while it runs) or the last closed thinking segment.
 *
 * Args:
 *   segments: The turn's segments so far.
 *   toolCalls: The turn's tool calls so far.
 *
 * Returns:
 *   That time in ms, or null when the turn has had no such event.
 */
export function lastEventAt(
  segments: readonly ThinkingSegment[],
  toolCalls: ReadonlyArray<{ startedAt: number; endedAt: number | null }>,
): number | null {
  let latest: number | null = null;
  for (const call of toolCalls) {
    const at = call.endedAt ?? call.startedAt;
    if (latest === null || at > latest) latest = at;
  }
  for (const segment of segments) {
    if (segment.endedAt !== null && (latest === null || segment.endedAt > latest)) {
      latest = segment.endedAt;
    }
  }
  return latest;
}

/**
 * A finished segment's length as the "Thought for" row shows it, in tenths
 * of a second.
 *
 * Args:
 *   startedAt: When the segment started, in ms; null when unknown.
 *   endedAt: When it ended, in ms.
 *
 * Returns:
 *   The seconds rounded to one decimal, or null when that would read 0.0,
 *   so the row says the model thought briefly instead.
 */
export function thoughtSeconds(startedAt: number | null, endedAt: number): number | null {
  if (startedAt === null) return null;
  const seconds = Math.round((endedAt - startedAt) / 100) / 10;
  return seconds > 0 ? seconds : null;
}

export type ActivityPiece<S, T> =
  | { kind: "thinking"; segment: S }
  | { kind: "steps"; steps: T[] }
  | { kind: "card"; step: T };

/**
 * Lay a turn's thinking segments and tool steps out in the order they ran:
 * each segment goes before the first step that started after it, and the
 * steps between two segments stay together as one burst. A step flagged
 * ``card`` (a rich card the user acts on) stands on its own at its place and
 * splits the burst around it.
 *
 * Args:
 *   segments: The turn's thinking segments, oldest first.
 *   steps: The steps to show, each with its index among the turn's tool calls.
 *
 * Returns:
 *   Thinking rows, step bursts and cards, interleaved.
 */
export function interleaveThinking<
  S extends { toolsBefore: number },
  T extends { index: number; card?: boolean },
>(segments: readonly S[], steps: readonly T[]): Array<ActivityPiece<S, T>> {
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
    if (step.card) {
      flush();
      out.push({ kind: "card", step });
    } else {
      burst.push(step);
    }
  }
  flush();
  for (; s < segments.length; s++) out.push({ kind: "thinking", segment: segments[s] as S });
  return out;
}
