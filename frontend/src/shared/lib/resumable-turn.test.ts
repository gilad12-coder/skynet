/** Contract: a resumable agent turn survives dropped/windowed responses with no lost or duplicated events, and abort cancels it server-side. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { streamResumableTurn } from "./resumable-turn.ts";
import { readServerSentEvents, type ServerSentEvent } from "./sse.ts";

function frame(id: number, event: string, data: Record<string, unknown>): string {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sseResponse(body: string, opts: { breakAfter?: boolean } = {}): Response {
  const bytes = new TextEncoder().encode(body);
  let sent = false;
  // Error on the pull after the data, so the reader sees the bytes first.
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(bytes);
      } else if (opts.breakAfter) controller.error(new TypeError("network error"));
      else controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

interface Call {
  url: string;
  init: RequestInit;
}

function scripted(responses: Array<(call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request ${url}`);
    return next(call);
  };
  return { fetch, calls };
}

const base = {
  read: readServerSentEvents,
  apiBase: "http://api",
  startPath: "/optimizations/ai-generate-code",
  startInit: { method: "POST", body: "{}" },
  retryDelayMs: () => 0,
};

const started = frame(1, "turn_started", { turn_id: "t1" });

test("a dropped connection resumes after the last id without duplicates", async () => {
  const { fetch, calls } = scripted([
    () => sseResponse(started + frame(2, "message_patch", { chunk: "a" }), { breakAfter: true }),
    // The server replays from ?after; a stray repeat of id 2 must be dropped.
    () =>
      sseResponse(
        frame(2, "message_patch", { chunk: "a" }) +
          frame(3, "message_patch", { chunk: "b" }) +
          frame(4, "done", {}) +
          frame(5, "turn_end", { status: "finished" }),
      ),
  ]);
  const seen: ServerSentEvent[] = [];
  const result = await streamResumableTurn({ ...base, fetch, onEvent: (e) => seen.push(e) });

  assert.deepEqual(result, { status: "ended" });
  assert.deepEqual(
    seen.map((e) => e.event + (e.data.chunk ?? "")),
    ["message_patcha", "message_patchb", "done"],
  );
  assert.equal(calls[1].url, "http://api/optimizations/agent-turns/t1/stream?after=2");
});

test("a response that closes without turn_end reconnects (server window)", async () => {
  const { fetch, calls } = scripted([
    () => sseResponse(started + frame(2, "message_patch", { chunk: "a" })),
    () => sseResponse(frame(3, "done", {}) + frame(4, "turn_end", { status: "finished" })),
  ]);
  const seen: string[] = [];
  const result = await streamResumableTurn({ ...base, fetch, onEvent: (e) => seen.push(e.event) });
  assert.deepEqual(result, { status: "ended" });
  assert.deepEqual(seen, ["message_patch", "done"]);
  assert.equal(calls.length, 2);
});

test("a server without turn framing ends with the response", async () => {
  const { fetch, calls } = scripted([() => sseResponse("event: done\ndata: {}\n\n")]);
  const result = await streamResumableTurn({ ...base, fetch, onEvent: () => {} });
  assert.deepEqual(result, { status: "ended" });
  assert.equal(calls.length, 1);
});

test("a failed start reports not started; a 404 resume fails without retrying", async () => {
  const first = scripted([
    () => {
      throw new TypeError("network error");
    },
  ]);
  const r1 = await streamResumableTurn({ ...base, fetch: first.fetch, onEvent: () => {} });
  assert.equal(r1.status, "failed");
  assert.equal(r1.status === "failed" && r1.started, false);

  const second = scripted([
    () => sseResponse(started, { breakAfter: true }),
    () => new Response("{}", { status: 404 }),
  ]);
  const r2 = await streamResumableTurn({ ...base, fetch: second.fetch, onEvent: () => {} });
  assert.equal(r2.status, "failed");
  assert.equal(r2.status === "failed" && r2.response?.status, 404);
  assert.equal(second.calls.length, 2);
});

test("gives up after the retry budget", async () => {
  const fail = () => {
    throw new TypeError("network error");
  };
  const { fetch, calls } = scripted([
    () => sseResponse(started, { breakAfter: true }),
    fail,
    fail,
    fail,
  ]);
  const result = await streamResumableTurn({ ...base, fetch, maxRetries: 2, onEvent: () => {} });
  assert.equal(result.status, "failed");
  assert.equal(calls.length, 3);
});

test("abort cancels the server-side turn", async () => {
  const controller = new AbortController();
  const { fetch, calls } = scripted([
    () => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(started));
          controller.signal.addEventListener("abort", () =>
            c.error(new DOMException("aborted", "AbortError")),
          );
        },
      });
      return new Response(stream, { status: 200 });
    },
    () => new Response(JSON.stringify({ cancelled: true }), { status: 200 }),
  ]);
  const pending = streamResumableTurn({
    ...base,
    fetch,
    signal: controller.signal,
    onEvent: () => {},
  });
  await new Promise((r) => setTimeout(r, 10));
  controller.abort();
  assert.deepEqual(await pending, { status: "aborted" });
  assert.equal(calls[1].url, "http://api/optimizations/agent-turns/t1/cancel");
  assert.equal(calls[1].init.method, "POST");
});
