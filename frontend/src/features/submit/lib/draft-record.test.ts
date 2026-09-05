import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DraftSaver,
  hasMeaningfulDraft,
  recipeToOpen,
  stripModelSecrets,
  sanitizeProgramDraft,
  type WizardDraftData,
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
  let resetGeneration = 0;
  const store: DraftStore = {
    read: async () => ({ record: stored, resetGeneration }),
    write: async (record, fence) => {
      if (fence !== resetGeneration) return false;
      if (failWrites) throw new Error("quota");
      stored = record;
      log.push(`write:${record.revision}`);
      return true;
    },
    remove: async () => {
      stored = null;
      log.push("remove");
      return ++resetGeneration;
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

test("the proposer runtime survives durable draft saving and restoration", async () => {
  const s = fakeStore();
  const timers = fakeTimers();
  const { saver } = saverWith(s.store, timers);
  saver.hold(false);
  saver.publish(
    "anything",
    anythingDraft({ objective: "Better code", proposerRuntime: "vercel" }),
    true,
  );
  await saver.flush();
  const restored = saverWith(s.store, fakeTimers()).saver;
  const snapshot = await s.store.read("me@example.com");
  restored.adopt(snapshot.record, snapshot.resetGeneration);
  assert.equal(restored.current?.anything?.data.proposerRuntime, "vercel");
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

test("restored Program drafts discard stored green checks and tool/model credentials", () => {
  const raw = {
    jobName: "Keep my name",
    codeAssistMode: "manual",
    splitMode: "manual",
    split: { train: 0.7, val: 0.2, test: 0.1 },
    signatureValidation: { valid: true, errors: [] },
    metricValidation: { valid: true, errors: [] },
    reactConfig: {
      mcpUrl: "https://tools.example.test/mcp",
      mcpAuthHeader: "Bearer secret",
      toolFilter: ["lookup", "search"],
    },
    modelConfig: { name: "task", extra: { api_key: "secret", temperature: 0.4 } },
    secondModelConfig: {
      name: "optimizer",
      extra: { headers: { Authorization: "secret", region: "eu" } },
    },
    generationModels: [],
    reflectionModels: [],
  } as unknown as WizardDraftData;
  const safe = sanitizeProgramDraft(raw);
  assert.equal("signatureValidation" in safe, false);
  assert.equal("metricValidation" in safe, false);
  assert.equal(safe.reactConfig.mcpAuthHeader, "");
  assert.equal(safe.reactConfig.mcpUrl, raw.reactConfig.mcpUrl);
  assert.deepEqual(safe.reactConfig.toolFilter, ["lookup", "search"]);
  assert.equal(JSON.stringify(safe).includes("secret"), false);
  assert.deepEqual(safe.split, raw.split);
  assert.equal(safe.splitMode, "manual");
  assert.equal(safe.codeAssistMode, "manual");
  assert.equal(safe.jobName, raw.jobName);
  assert.deepEqual(safe.secondModelConfig?.extra, { headers: { region: "eu" } });
});

test("a missed cross-tab reset message still fences an old saver out of storage", async () => {
  const s = fakeStore();
  const old = saverWith(s.store, fakeTimers()).saver;
  old.adopt(null);
  old.hold(false);
  old.publish("anything", anythingDraft({ objective: "discarded" }), true);
  await old.flush();
  const other = saverWith(s.store, fakeTimers()).saver;
  const snapshot = await s.store.read("me@example.com");
  other.adopt(snapshot.record, snapshot.resetGeneration);
  await other.reset();
  old.publish("anything", anythingDraft({ objective: "stale tab edit" }), true);
  await old.flush();
  assert.equal(s.stored, null);
  assert.equal(old.isHeld, true);
  other.hold(false);
  other.publish("anything", anythingDraft({ objective: "new setup" }), true);
  await other.flush();
  assert.equal(s.stored?.anything?.data.objective, "new setup");
});

test("edits made during a write survive its completion and the next flush", async () => {
  const s = fakeStore();
  let release!: () => void;
  let started!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const originalWrite = s.store.write;
  let writes = 0;
  s.store.write = async (record, fence) => {
    if (++writes === 1) {
      started();
      await gate;
    }
    return originalWrite(record, fence);
  };
  const { saver } = saverWith(s.store, fakeTimers());
  saver.hold(false);
  saver.publish("anything", anythingDraft({ objective: "before" }), true);
  const first = saver.flush();
  await began;
  saver.publish("anything", anythingDraft({ objective: "after" }), true);
  const second = saver.flush();
  release();
  await Promise.all([first, second]);
  assert.equal(s.stored?.anything?.data.objective, "after");
  assert.equal(s.stored?.revision, 2);
  assert.equal(saver.current?.anything?.data.objective, "after");
});

test("reset waits for an active write and then removes its contents", async () => {
  const s = fakeStore();
  let release!: () => void;
  let started!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const originalWrite = s.store.write;
  s.store.write = async (record, fence) => {
    started();
    await gate;
    return originalWrite(record, fence);
  };
  const { saver } = saverWith(s.store, fakeTimers());
  saver.hold(false);
  saver.publish("anything", anythingDraft({ objective: "discard me" }), true);
  const writing = saver.flush();
  await began;
  const resetting = saver.reset();
  release();
  await Promise.all([writing, resetting]);
  assert.equal(s.stored, null);
  assert.deepEqual(s.log, ["write:1", "remove"]);
});

test("shared budget identities survive workflow changes and reject failed durable saves", async () => {
  const store = fakeStore();
  const { saver } = saverWith(store.store, fakeTimers());
  saver.hold(false);
  saver.publish("anything", anythingDraft({ objective: "Improve this" }), true);
  await saver.saveExecution({
    executionBudgetRef: { id: "budget", revision: 2 },
    budgetCreateIdempotencyKey: "create-key",
    submissionIdempotencyKey: "submit-key",
    budgetTotalCredits: 30,
  });
  saver.publish("program", { stage: "goal", maxCostCredits: 5 } as WizardDraftData, true);
  await saver.flush();
  assert.deepEqual(store.stored?.executionBudgetRef, { id: "budget", revision: 2 });
  assert.equal(store.stored?.budgetTotalCredits, 30);
  assert.equal(store.stored?.submissionIdempotencyKey, "submit-key");
  store.setFailWrites(true);
  await assert.rejects(saver.saveExecution({ budgetCreateIdempotencyKey: "next" }), /quota/);
});
