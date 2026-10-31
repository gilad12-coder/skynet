import { test } from "node:test";
import assert from "node:assert/strict";
import { joinInFlight } from "./byok.ts";

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

void test("joinInFlight: N concurrent key-list reloads send one request", async () => {
  const inFlight: { current: Promise<void> | null } = { current: null };
  const gate = deferred();
  let requests = 0;
  const fetchKeys = (): Promise<void> => {
    requests += 1;
    return gate.promise;
  };
  // Five mounted menus fire their retry timer in the same tick.
  const calls = Array.from({ length: 5 }, () => joinInFlight(inFlight, fetchKeys));
  assert.equal(requests, 1);
  for (const call of calls) assert.equal(call, calls[0]);
  gate.resolve();
  await Promise.all(calls);
  assert.equal(inFlight.current, null);
});

void test("joinInFlight: a reload after the pending one settles fetches again", async () => {
  const inFlight: { current: Promise<void> | null } = { current: null };
  let requests = 0;
  const fetchKeys = async (): Promise<void> => {
    requests += 1;
  };
  await joinInFlight(inFlight, fetchKeys);
  await joinInFlight(inFlight, fetchKeys);
  assert.equal(requests, 2);
});

void test("joinInFlight: a rejected run clears the slot so the next retry fetches", async () => {
  const inFlight: { current: Promise<void> | null } = { current: null };
  const gate = deferred();
  let requests = 0;
  const first = joinInFlight(inFlight, () => {
    requests += 1;
    return gate.promise;
  });
  const second = joinInFlight(inFlight, () => {
    requests += 1;
    return Promise.resolve();
  });
  gate.reject(new Error("offline"));
  await assert.rejects(first, /offline/);
  await assert.rejects(second, /offline/);
  assert.equal(inFlight.current, null);
  await joinInFlight(inFlight, async () => {
    requests += 1;
  });
  assert.equal(requests, 2);
});
