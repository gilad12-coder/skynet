"use client";

import { useEffect, useRef, useState } from "react";
import { fetchWithAuthRetry } from "@/shared/lib/api";
import { readServerSentEvents } from "@/shared/lib/sse";
import type { OptimizationLogEntry } from "@/shared/types/api";

/** `live` while connected, `reconnecting` between attempts, `ended` once the run's log is complete. */
export type RunLogStreamStatus = "idle" | "live" | "reconnecting" | "ended";

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 15000;

/**
 * Tail a run's log over SSE, resuming after the last row id received so a
 * dropped connection backfills exactly what it missed.
 *
 * @param url Stream endpoint without the cursor; empty disables the stream.
 * @param startAfter Row id to resume after on the first connect, read once when the stream starts.
 * @param onEntries Receives each batch of new rows, oldest first.
 */
export function useRunLogStream(
  url: string,
  startAfter: () => number | null,
  onEntries: (entries: OptimizationLogEntry[]) => void,
): RunLogStreamStatus {
  const [status, setStatus] = useState<RunLogStreamStatus>("idle");
  const onEntriesRef = useRef(onEntries);
  const startAfterRef = useRef(startAfter);
  useEffect(() => {
    onEntriesRef.current = onEntries;
    startAfterRef.current = startAfter;
  });

  useEffect(() => {
    if (!url) {
      setStatus("idle");
      return;
    }
    const abort = new AbortController();
    let cursor = startAfterRef.current();
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const connect = async () => {
      const target = cursor === null ? url : `${url}?after_id=${cursor}`;
      let ended = false;
      try {
        const res = await fetchWithAuthRetry(target, {
          headers: { Accept: "text/event-stream" },
          signal: abort.signal,
          cache: "no-store",
        });
        // Not found or forbidden will not heal on retry; the run page shows its own error.
        if (res.status === 401 || res.status === 403 || res.status === 404) {
          setStatus("ended");
          return;
        }
        if (!res.ok || !res.body) throw new Error(`log stream ${res.status}`);
        setStatus("live");
        attempt = 0;
        await readServerSentEvents(res.body, ({ event, data, id }) => {
          if (event === "logs") {
            const entries = (data.entries ?? []) as OptimizationLogEntry[];
            if (id !== undefined) cursor = Number(id);
            if (entries.length > 0) onEntriesRef.current(entries);
          } else if (event === "done" || event === "error") {
            ended = true;
          }
        });
      } catch (err) {
        if ((err as Error)?.name === "AbortError" || abort.signal.aborted) return;
      }
      if (abort.signal.aborted) return;
      if (ended) {
        setStatus("ended");
        return;
      }
      setStatus("reconnecting");
      const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt);
      attempt += 1;
      retryTimer = setTimeout(() => void connect(), delay);
    };

    void connect();
    return () => {
      abort.abort();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [url]);

  return status;
}
