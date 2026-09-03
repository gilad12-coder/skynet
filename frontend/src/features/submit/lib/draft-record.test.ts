import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DraftSaver,
  hasMeaningfulDraft,
  recipeToOpen,
  stripModelSecrets,
  type AnythingDraftData,
  type DraftStore,
  type WizardDraftRecord,
} from "./draft-record.ts";

function anythingDraft(overrides: Partial<AnythingDraftData> = {}): AnythingDraftData {
  return {
    stage: "goal",
    furthestStage: "goal",
    jobName: "",
    jobDescription: "",
    isPrivate: true,
    recipe: "anything",
    codeAssistMode: "auto",
    seedMode: "text",
    seedText: "",
    seedParts: [{ key: "", value: "" }],
    seedManuallyEdited: false,
    scorerManuallyEdited: false,
    objective: "",
    background: "",
    targetKind: "text",
    harness: "pi",
    targetModel: { name: "" },
    targetTimeout: 600,
    targetConcurrency: 2,
    parsedCases: null,
    casesName: "",
    split: { train: 0.6, val: 0.2, test: 0.2 },
    shuffle: true,
    seed: undefined,
    splitMode: "auto",
    scorerKind: "python",
    metricCode: "",
    scorerUrl: "",
    scorerInstall: "",
    scorerModel: { name: "" },
    scorerModelDeclared: false,
    scorerModelMode: "inherit",
    strategyMode: "auto",
    engine: null,
    patience: 5,
    maxScorerRuns: 100,
    maxIterations: "",
    stopAtScore: "",
    reflectionModel: { name: "" },
    maxCostCredits: null,
    setupSpent: 0,
    ...overrides,
  };
}

function fakeStore() {
  let stored: WizardDraftRecord | null = null;
  const log: string[] = [];
  let failWrites = false;
  const store: DraftStore = {
    read: async () => stored,
    write: async (record) => {
      if (failWrites) throw new Error("quota");
      stored = record;
      log.push(`write:${record.revision}`);
    },
    remove: async () => {
      stored = null;
      log.push("remove");
    },
  };
  return {
    store,
    log,
    get stored() {
      return stored;
    },
    setFailWrites(v: boolean) {
      failWrites = v;
    },
  };
}

function fakeTimers() {
  const queue: Array<{ fn: () => void; handle: number }> = [];
  let next = 1;
  return {
    setTimer: (fn: () => void) => {
      const handle = next++;
      queue.push({ fn, handle });
      return handle;
    },
    clearTimer: (handle: unknown) => {
      const i = queue.findIndex((q) => q.handle === handle);
      if (i >= 0) queue.splice(i, 1);
    },
    async fire() {
      const pending = queue.splice(0);
      for (const q of pending) q.fn();
      await new Promise((r) => setTimeout(r, 0));
    },
    get pending() {
      return queue.length;
    },
  };
}

function saverWith(store: DraftStore, timers: ReturnType<typeof fakeTimers>) {
  const errors: unknown[] = [];
  const saver = new DraftSaver("me@example.com", {
    store,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    now: () => 1000,
    newId: () => "draft-1",
    onWriteError: (e) => errors.push(e),
  });
  return { saver, errors };
}

test("stripModelSecrets drops the inline api key and keeps the rest of the choice", () => {
  const stripped = stripModelSecrets({
    name: "gpt",
    token_source: "byok",
    extra: { api_key: "sk-secret", region: "eu" },
  });
  assert.deepEqual(stripped, { name: "gpt", token_source: "byok", extra: { region: "eu" } });
  assert.equal(
    stripModelSecrets({ name: "gpt", extra: { api_key: "sk-secret" } }).extra,
    undefined,
  );
  const plain = { name: "gpt" };
  assert.equal(stripModelSecrets(plain), plain);
});

test("recipeToOpen prefers the active workflow while it still has content", () => {
  const base: WizardDraftRecord = {
    version: 1,
    id: "d",
    accountId: "a",
    activeRecipe: "anything",
    revision: 1,
    updatedAt: 0,
    program: { data: {} as never, meaningful: true },
    anything: { data: anythingDraft(), meaningful: false },
  };
  assert.equal(recipeToOpen(base), "program");
  assert.equal(
    recipeToOpen({ ...base, anything: { data: anythingDraft(), meaningful: true } }),
    "anything",
  );
  assert.equal(recipeToOpen({ ...base, program: null }), null);
  assert.equal(hasMeaningfulDraft({ ...base, program: null }), false);
});

test("a held saver writes nothing; release writes once per distinct snapshot", async () => {
  const s = fakeStore();
  const timers = fakeTimers();
  const { saver } = saverWith(s.store, timers);
  const draft = anythingDraft({ objective: "shorter emails" });
  saver.publish("anything", draft, true);
  await timers.fire();
  assert.deepEqual(s.log, []);

  saver.adopt(null);
  saver.hold(false);
  await timers.fire();
  assert.deepEqual(s.log, ["write:1"]);
  assert.equal(s.stored?.activeRecipe, "anything");
  assert.equal(s.stored?.id, "draft-1");

  saver.publish("anything", { ...draft }, true);
  assert.equal(timers.pending, 0);

  saver.publish("anything", { ...draft, objective: "shorter, kinder emails" }, true);
  await timers.fire();
  assert.deepEqual(s.log, ["write:1", "write:2"]);
});

test("blanking every field removes the stored record", async () => {
  const s = fakeStore();
  const timers = fakeTimers();
  const { saver } = saverWith(s.store, timers);
  saver.adopt(null);
  saver.hold(false);
  saver.publish("anything", anythingDraft({ objective: "x" }), true);
  await timers.fire();
  const blank = anythingDraft();
  saver.publish("anything", blank, false);
  await timers.fire();
  assert.deepEqual(s.log, ["write:1", "remove"]);
  assert.equal(s.stored, null);
  saver.publish("anything", blank, false);
  assert.equal(timers.pending, 0);
});

test("reset deletes the record and a late debounced write cannot resurrect it", async () => {
  const s = fakeStore();
  const timers = fakeTimers();
  const { saver } = saverWith(s.store, timers);
  saver.adopt(null);
  saver.hold(false);
  saver.publish("program", { jobName: "keep me" } as never, true);
  await timers.fire();
  assert.equal(s.stored?.revision, 1);

  saver.publish("program", { jobName: "keep me too" } as never, true);
  const fire = timers.fire.bind(timers);
  await saver.reset();
  await fire();
  assert.equal(s.stored, null);
  assert.deepEqual(s.log, ["write:1", "remove"]);
  assert.equal(saver.current, null);
});

test("a failed write keeps the snapshot dirty and reports once per attempt", async () => {
  const s = fakeStore();
  const timers = fakeTimers();
  const { saver, errors } = saverWith(s.store, timers);
  saver.adopt(null);
  saver.hold(false);
  s.setFailWrites(true);
  saver.publish("anything", anythingDraft({ objective: "x" }), true);
  await timers.fire();
  assert.equal(errors.length, 1);
  assert.equal(s.stored, null);
  s.setFailWrites(false);
  await saver.flush();
  assert.equal(s.stored?.revision, 1);
});

test("detach forgets the record without touching storage", async () => {
  const s = fakeStore();
  const timers = fakeTimers();
  const { saver } = saverWith(s.store, timers);
  saver.adopt(null);
  saver.hold(false);
  saver.publish("anything", anythingDraft({ objective: "x" }), true);
  await timers.fire();
  saver.detach();
  assert.equal(saver.current, null);
  assert.equal(saver.isHeld, true);
  assert.equal(s.stored?.revision, 1);
});
