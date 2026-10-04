/**
 * Client side of a resumable agent turn (see backend `core/api/agent_turns.py`).
 *
 * The hosting edge cuts every HTTP request at 15 minutes, so a long agent turn
 * runs server-side independent of its connection. The server opens the stream
 * with `turn_started` (carrying the turn id), numbers every event with an SSE
 * `id`, and closes the turn with `turn_end`. A response that ends without
 * `turn_end` — the server's own response window, or a dropped connection — is
 * resumed from the last id received, so handlers see every event exactly once.
 * Aborting the signal asks the server to stop the turn.
 */

import type { ServerSentEvent } from "./sse.ts";

export const TURN_STARTED_EVENT = "turn_started";
export const TURN_END_EVENT = "turn_end";

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
type SseReader = (
  body: ReadableStream<Uint8Array>,
  processEvent: (event: ServerSentEvent) => void,
) => Promise<void>;

export interface ResumableTurnOptions {
  /** Authenticated fetch used for every request. */
  fetch: Fetcher;
  /** SSE body reader (injected so this module stays dependency-free). */
  read: SseReader;
  /** API base URL, without a trailing slash. */
  apiBase: string;
  /** Path of the POST that starts the turn. */
  startPath: string;
  /** Init of the starting POST (method, headers, body); the signal is added here. */
  startInit: RequestInit;
  onEvent: (event: ServerSentEvent) => void;
  signal?: AbortSignal;
  /** Consecutive failed reconnects tolerated before giving up. */
  maxRetries?: number;
  /** Delay before reconnect attempt `n` (1-based). */
  retryDelayMs?: (attempt: number) => number;
}

export type ResumableTurnResult =
  | { status: "ended" }
  | { status: "aborted" }
  /** `started` is false when the turn never began (the first request failed). */
  | { status: "failed"; started: boolean; response?: Response; error?: unknown };

const DEFAULT_MAX_RETRIES = 8;
// A response that ends this fast with nothing in it is a failure, not the
// server's response window closing.
const MIN_HEALTHY_RESPONSE_MS = 5000;

function defaultRetryDelayMs(attempt: number): number {
  return Math.min(8000, 500 * 2 ** (attempt - 1));
}

function isAbortError(err: unknown): boolean {
  return (err as Error | null)?.name === "AbortError";
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Stream a resumable agent turn to completion, reconnecting as needed. */
export async function streamResumableTurn(
  opts: ResumableTurnOptions,
): Promise<ResumableTurnResult> {
  const { signal } = opts;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryDelayMs = opts.retryDelayMs ?? defaultRetryDelayMs;
  let turnId: string | null = null;
  let lastSeq = 0;
  let failures = 0;
  let started = false;

  const onAbort = () => {
    if (!turnId) return;
    // Not tied to `signal` (already aborted); keepalive lets the Stop land
    // even when the abort comes from the page unloading.
    void opts
      .fetch(`${opts.apiBase}/optimizations/agent-turns/${encodeURIComponent(turnId)}/cancel`, {
        method: "POST",
        keepalive: true,
      })
      .catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  // Returns false once the retry budget is spent (or the user aborted).
  const backoff = async (): Promise<boolean> => {
    failures += 1;
    if (failures > maxRetries) return false;
    await wait(retryDelayMs(failures), signal);
    return !signal?.aborted;
  };

  try {
    for (;;) {
      if (signal?.aborted) return { status: "aborted" };
      let res: Response;
      try {
        res = turnId
          ? await opts.fetch(
              `${opts.apiBase}/optimizations/agent-turns/${encodeURIComponent(turnId)}/stream?after=${lastSeq}`,
              { method: "GET", headers: { Accept: "text/event-stream" }, signal },
            )
          : await opts.fetch(`${opts.apiBase}${opts.startPath}`, { ...opts.startInit, signal });
      } catch (error) {
        if (isAbortError(error) || signal?.aborted) return { status: "aborted" };
        if (!turnId) return { status: "failed", started, error };
        if (await backoff()) continue;
        return signal?.aborted ? { status: "aborted" } : { status: "failed", started, error };
      }
      if (!res.ok || !res.body) {
        // 5xx on a resume is the edge or a restarting replica; a 404 means the
        // turn is gone and retrying cannot help.
        if (turnId && res.status >= 500 && (await backoff())) continue;
        if (signal?.aborted) return { status: "aborted" };
        return { status: "failed", started, response: res };
      }
      started = true;

      let ended = false;
      let received = 0;
      const openedAt = Date.now();
      try {
        await opts.read(res.body, (event) => {
          if (event.id !== undefined) {
            const seq = Number(event.id);
            if (Number.isFinite(seq)) {
              if (seq <= lastSeq) return;
              lastSeq = seq;
            }
          }
          received += 1;
          failures = 0;
          if (event.event === TURN_STARTED_EVENT) {
            const id = event.data.turn_id;
            if (typeof id === "string" && id) turnId = id;
            return;
          }
          if (event.event === TURN_END_EVENT) {
            ended = true;
            return;
          }
          opts.onEvent(event);
        });
      } catch (error) {
        if (isAbortError(error) || signal?.aborted) return { status: "aborted" };
        if (!turnId) return { status: "failed", started, error };
        if (await backoff()) continue;
        return signal?.aborted ? { status: "aborted" } : { status: "failed", started, error };
      }
      if (ended) return { status: "ended" };
      // A server without turn framing: the response end is the turn end.
      if (!turnId) return { status: "ended" };
      if (received === 0 && Date.now() - openedAt < MIN_HEALTHY_RESPONSE_MS && !(await backoff())) {
        return signal?.aborted
          ? { status: "aborted" }
          : { status: "failed", started, error: new Error("agent turn stream keeps closing") };
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
