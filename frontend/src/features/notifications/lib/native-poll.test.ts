import { test } from "node:test";
import assert from "node:assert/strict";

import type { NativeNotification } from "@/shared/lib/api";

import { probeUntilAnswered, showClaimed } from "./native-poll.ts";

/** A manual timer queue, so retries run without waiting. */
function manualTimers() {
  const queue: Array<() => void> = [];
  const delays: number[] = [];
  return {
    delays,
    schedule: (fn: () => void, ms: number) => {
      queue.push(fn);
      delays.push(ms);
      return () => {
        const i = queue.indexOf(fn);
        if (i >= 0) queue.splice(i, 1);
      };
    },
    runNext: () => queue.shift()?.(),
    pending: () => queue.length,
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("the setup check retries after an error until it gets an answer", async () => {
  const timers = manualTimers();
  const answers: unknown[] = [];
  let calls = 0;
  const probe = () => {
    calls += 1;
    return calls < 3 ? Promise.reject(new Error("API restarting")) : Promise.resolve({ ok: true });
  };
  probeUntilAnswered(probe, (value) => answers.push(value), 10_000, timers.schedule);
  await flush();
  assert.equal(calls, 1);
  assert.deepEqual(timers.delays, [10_000]);
  timers.runNext();
  await flush();
  timers.runNext();
  await flush();
  assert.equal(calls, 3);
  assert.deepEqual(answers, [{ ok: true }]);
  assert.equal(timers.pending(), 0);
});

test("a 404 answer (null: a hosted server) ends the check without a retry", async () => {
  const timers = manualTimers();
  const answers: unknown[] = [];
  probeUntilAnswered(
    () => Promise.resolve(null),
    (value) => answers.push(value),
    10_000,
    timers.schedule,
  );
  await flush();
  assert.deepEqual(answers, [null]);
  assert.equal(timers.pending(), 0);
});

test("a cancelled check neither answers nor retries", async () => {
  const timers = manualTimers();
  const answers: unknown[] = [];
  const cancel = probeUntilAnswered(
    () => Promise.reject(new Error("down")),
    (value) => answers.push(value),
    10_000,
    timers.schedule,
  );
  await flush();
  cancel();
  assert.equal(timers.pending(), 0);
  const late = probeUntilAnswered(
    () => Promise.resolve(1),
    (value) => answers.push(value),
    10_000,
    timers.schedule,
  );
  late();
  await flush();
  assert.deepEqual(answers, []);
});

function note(id: string): NativeNotification {
  return { id, title: `t-${id}`, body: "", url: `/optimizations/${id}`, tag: `finished:${id}` };
}

test("only the notifications actually shown are confirmed", () => {
  const shown = showClaimed([note("a"), note("b"), note("c")], (item) => item.id !== "b");
  assert.deepEqual(shown, ["a", "c"]);
});
