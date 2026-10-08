import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const store = new Map<string, string>();
(globalThis as { window?: unknown }).window = {
  sessionStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  },
};

const { hintedCount, layoutHint, rememberLayout, resetLayoutHintsForTests } = await import(
  "./layout-hint.ts"
);

beforeEach(() => {
  store.clear();
  resetLayoutHintsForTests();
});

test("a remembered layout survives a fresh module state (a reload)", () => {
  rememberLayout("k", { groups: [2, 3] });
  resetLayoutHintsForTests();
  assert.deepEqual(layoutHint("k"), { groups: [2, 3] });
});

test("nothing remembered reads as undefined", () => {
  assert.equal(layoutHint("missing"), undefined);
  assert.equal(layoutHint(undefined), undefined);
});

test("an unreadable stored value reads as undefined", () => {
  store.set("skynet-layout:bad", "{not json");
  assert.equal(layoutHint("bad"), undefined);
});

test("hintedCount clamps, floors, keeps 0, and falls back on junk", () => {
  assert.equal(hintedCount(undefined, 4), 4);
  assert.equal(hintedCount("3", 4), 4);
  assert.equal(hintedCount(-1, 4), 4);
  assert.equal(hintedCount(0, 4), 0);
  assert.equal(hintedCount(7.8, 4, 6), 6);
  assert.equal(hintedCount(2.9, 4), 2);
});
