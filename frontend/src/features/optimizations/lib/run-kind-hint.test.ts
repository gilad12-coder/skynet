import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const store = new Map<string, string>();
(globalThis as { window?: unknown }).window = {
  sessionStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  },
};

const hint = await import("./run-kind-hint.ts");

beforeEach(() => {
  store.clear();
  hint.resetRunShapeHintsForTests();
});

test("a pair view keeps its own shape", () => {
  assert.equal(hint.runShapeKey("r1", false), "r1");
  assert.equal(hint.runShapeKey("r1", true), "r1#pair");
});

test("a remembered shape merges and survives a reload of the module cache", () => {
  hint.rememberRunKind("r1", "blackbox");
  hint.rememberRunShape("r1", { stages: [{ detail: true, foot: "chip" }], tabs: 7 });
  hint.resetRunShapeHintsForTests();
  assert.deepEqual(hint.runShapeHint("r1"), {
    kind: "blackbox",
    stages: [{ detail: true, foot: "chip" }],
    tabs: 7,
  });
  assert.equal(hint.runKindHint("r1"), "blackbox");
});

test("a hint stored as a bare kind still reads", () => {
  store.set("skynet-run-kind:r2", "grid_search");
  assert.equal(hint.runKindHint("r2"), "grid_search");
});

test("an unreadable hint is ignored", () => {
  store.set("skynet-run-kind:r3", "{broken");
  assert.equal(hint.runKindHint("r3"), undefined);
  assert.equal(hint.runShapeHint(undefined), undefined);
});

test("a probe seeds the stage plan but never overwrites a rendered one", () => {
  const planned = [
    { detail: false, foot: "time" as const },
    { detail: true, foot: "time" as const },
    { detail: false, foot: "time" as const },
  ];
  hint.rememberProbedRun("r4", "blackbox", planned);
  assert.equal(hint.runShapeHint("r4")?.stages?.length, 3);
  const rendered = [{ detail: true, foot: "chip" as const }];
  hint.rememberRunShape("r4", { stages: rendered });
  hint.rememberProbedRun("r4", "blackbox", planned);
  assert.deepEqual(hint.runShapeHint("r4")?.stages, rendered);
});

test("the access strip and action counts round-trip, including an own run", () => {
  hint.rememberRunShape("r3", {
    access: { tier: "viewer", owner: "dana" },
    actions: { wide: 3, phone: null },
  });
  hint.rememberRunShape("r4", { access: null });
  hint.resetRunShapeHintsForTests();
  assert.deepEqual(hint.runShapeHint("r3")?.access, { tier: "viewer", owner: "dana" });
  assert.deepEqual(hint.runShapeHint("r3")?.actions, { wide: 3, phone: null });
  assert.equal(hint.runShapeHint("r4")?.access, null);
});
