import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTabActivityStore, resolveTabActivity } from "./tab-activity.ts";

describe("resolveTabActivity", () => {
  it("shows nothing when no surface is registered", () => {
    assert.equal(resolveTabActivity([]), null);
  });

  it("lets a busy surface win over idle ones", () => {
    assert.equal(resolveTabActivity(["idle", "idle"]), "idle");
    assert.equal(resolveTabActivity(["idle", "busy", "idle"]), "busy");
  });
});

describe("createTabActivityStore", () => {
  it("resolves across surfaces and notifies only when the mark changes", () => {
    const store = createTabActivityStore();
    const seen: Array<"idle" | "busy" | null> = [];
    store.subscribe(() => seen.push(store.get()));
    const panel = {};
    const check = {};

    store.set(panel, "idle");
    store.set(check, "idle");
    store.set(check, "busy");
    store.set(panel, "busy");
    store.clear(check);
    store.set(panel, "idle");
    store.clear(panel);
    store.clear(panel);

    assert.deepEqual(seen, ["idle", "busy", "idle", null]);
    assert.equal(store.get(), null);
  });

  it("treats null as withdrawing the surface", () => {
    const store = createTabActivityStore();
    const token = {};
    store.set(token, "busy");
    store.set(token, null);
    assert.equal(store.get(), null);
  });

  it("stops notifying an unsubscribed listener", () => {
    const store = createTabActivityStore();
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });
    const token = {};
    store.set(token, "idle");
    unsubscribe();
    store.set(token, "busy");
    assert.equal(calls, 1);
  });
});
