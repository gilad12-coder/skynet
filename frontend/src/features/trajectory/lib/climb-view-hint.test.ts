import { test } from "node:test";
import assert from "node:assert/strict";

const store = new Map<string, string>();
(globalThis as { window?: unknown }).window = {
  sessionStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  },
};

const { rememberTrajectoryView, trajectoryViewHint } = await import("./climb-view-hint.ts");

test("each trajectory view is remembered per key", () => {
  rememberTrajectoryView("r1", "plain");
  rememberTrajectoryView("r1#pair", "none");
  assert.equal(store.get("skynet-climb-view:r1"), "plain");
  assert.equal(trajectoryViewHint("r1#pair"), "none");
});

test("the climb flag stored before views existed reads as the climb chart", () => {
  store.set("skynet-climb-view:old", "1");
  assert.equal(trajectoryViewHint("old"), "climb");
  store.set("skynet-climb-view:junk", "tree");
  assert.equal(trajectoryViewHint("junk"), undefined);
});
