/** Tests for the agent chats' mid-turn steer/queue store and key mapping. */

import assert from "node:assert/strict";
import test from "node:test";

import {
  appendToDraft,
  midTurnKeyAction,
  SteerQueue,
  type SteerChannel,
} from "./steer-queue.ts";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface FakeChannel extends SteerChannel {
  posted: string[];
  unread: Set<string>;
  withdrawCalls: number;
}

function fakeChannel(): FakeChannel {
  const channel: FakeChannel = {
    posted: [],
    unread: new Set(),
    withdrawCalls: 0,
    post: async (text) => {
      channel.posted.push(text);
      const id = `srv-${channel.posted.length}`;
      channel.unread.add(id);
      return id;
    },
    withdraw: async () => {
      channel.withdrawCalls += 1;
      const ids = [...channel.unread];
      channel.unread.clear();
      return ids;
    },
  };
  return channel;
}

function setup() {
  const sent: string[] = [];
  const queue = new SteerQueue((text) => sent.push(text));
  return { queue, sent };
}

const key = (k: string, mods: Partial<Record<"shiftKey" | "altKey" | "ctrlKey" | "metaKey", boolean>> = {}) => ({
  key: k,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  ...mods,
});

test("Enter steers while a steerable turn runs, Tab queues, Shift+Enter is left alone", () => {
  const ctx = { streaming: true, draft: "hi", canSteer: true, queuedCount: 0 };
  assert.equal(midTurnKeyAction(key("Enter"), ctx), "steer");
  assert.equal(midTurnKeyAction(key("Tab"), ctx), "queue");
  assert.equal(midTurnKeyAction(key("Enter", { shiftKey: true }), ctx), null);
});

test("Enter queues in a chat that cannot steer", () => {
  const ctx = { streaming: true, draft: "hi", canSteer: false, queuedCount: 0 };
  assert.equal(midTurnKeyAction(key("Enter"), ctx), "queue");
});

test("keys do nothing special when idle or with an empty draft", () => {
  assert.equal(midTurnKeyAction(key("Enter"), { streaming: false, draft: "hi", canSteer: false, queuedCount: 0 }), null);
  assert.equal(midTurnKeyAction(key("Tab"), { streaming: false, draft: "hi", canSteer: false, queuedCount: 0 }), null);
  assert.equal(midTurnKeyAction(key("Tab"), { streaming: true, draft: "  ", canSteer: true, queuedCount: 0 }), null);
});

test("Up in an empty composer recalls only when something is queued", () => {
  assert.equal(midTurnKeyAction(key("ArrowUp"), { streaming: true, draft: "", canSteer: true, queuedCount: 1 }), "recall");
  assert.equal(midTurnKeyAction(key("ArrowUp"), { streaming: true, draft: "", canSteer: true, queuedCount: 0 }), null);
  assert.equal(midTurnKeyAction(key("ArrowUp"), { streaming: true, draft: "x", canSteer: true, queuedCount: 1 }), null);
});

test("steer posts into the open turn and shows as steering until applied", async () => {
  const { queue } = setup();
  const channel = fakeChannel();
  queue.openTurn(channel);
  assert.equal(queue.getSnapshot().canSteer, true);
  queue.steer("use pandas");
  assert.deepEqual(queue.getSnapshot().steering.map((s) => s.text), ["use pandas"]);
  await flush();
  assert.deepEqual(channel.posted, ["use pandas"]);
  queue.applied(["srv-1"]);
  assert.equal(queue.getSnapshot().steering.length, 0);
});

test("a steer applied before its POST resolves is still cleared", async () => {
  const { queue } = setup();
  let resolvePost: (id: string) => void = () => {};
  queue.openTurn({
    post: () => new Promise((resolve) => (resolvePost = resolve)),
    withdraw: async () => [],
  });
  queue.steer("early");
  queue.applied(["srv-x"]);
  resolvePost("srv-x");
  await flush();
  assert.equal(queue.getSnapshot().steering.length, 0);
});

test("steer without an open turn falls back to the queue", async () => {
  const { queue, sent } = setup();
  queue.setBusy(true);
  queue.steer("later");
  assert.deepEqual(queue.getSnapshot().queued.map((q) => q.text), ["later"]);
  queue.setBusy(false);
  await flush();
  assert.deepEqual(sent, ["later"]);
});

test("queued follow-ups auto-send one at a time, FIFO, as the chat goes idle", async () => {
  const { queue, sent } = setup();
  queue.setBusy(true);
  queue.enqueue("first");
  queue.enqueue("second");
  await flush();
  assert.deepEqual(sent, []);
  queue.setBusy(false);
  await flush();
  assert.deepEqual(sent, ["first"]);
  assert.deepEqual(queue.getSnapshot().queued.map((q) => q.text), ["second"]);
  // The owner starts the first follow-up's turn, which then ends.
  queue.setBusy(true);
  queue.setBusy(false);
  await flush();
  assert.deepEqual(sent, ["first", "second"]);
});

test("enqueue while idle sends right away", async () => {
  const { queue, sent } = setup();
  queue.enqueue("now");
  await flush();
  assert.deepEqual(sent, ["now"]);
});

test("turn end withdraws unread steers to the front of the queue and sends them next", async () => {
  const { queue, sent } = setup();
  const channel = fakeChannel();
  queue.openTurn(channel);
  queue.enqueue("queued earlier");
  queue.steer("read");
  queue.steer("unread");
  await flush();
  queue.applied(["srv-1"]);
  channel.unread.delete("srv-1");
  queue.setBusy(false);
  await flush();
  assert.equal(channel.withdrawCalls, 1);
  assert.deepEqual(sent, ["unread"]);
  assert.deepEqual(queue.getSnapshot().queued.map((q) => q.text), ["queued earlier"]);
  assert.equal(queue.getSnapshot().steering.length, 0);
});

test("a failed withdraw keeps the user's steers rather than losing them", async () => {
  const { queue, sent } = setup();
  queue.openTurn({
    post: async () => "srv-1",
    withdraw: async () => {
      throw new Error("network");
    },
  });
  queue.steer("keep me");
  await flush();
  queue.setBusy(false);
  await flush();
  assert.deepEqual(sent, ["keep me"]);
});

test("a rejected steer POST moves the message to the queue", async () => {
  const { queue } = setup();
  queue.openTurn({ post: async () => null, withdraw: async () => [] });
  queue.steer("no mailbox");
  await flush();
  assert.equal(queue.getSnapshot().steering.length, 0);
  assert.deepEqual(queue.getSnapshot().queued.map((q) => q.text), ["no mailbox"]);
});

test("promote moves a queued follow-up into the running turn", async () => {
  const { queue } = setup();
  const channel = fakeChannel();
  queue.openTurn(channel);
  queue.enqueue("promote me");
  const id = queue.getSnapshot().queued[0].id;
  queue.promote(id);
  await flush();
  assert.equal(queue.getSnapshot().queued.length, 0);
  assert.deepEqual(channel.posted, ["promote me"]);
});

test("promote is a no-op when no steerable turn runs", () => {
  const { queue } = setup();
  queue.setBusy(true);
  queue.enqueue("stay");
  queue.promote(queue.getSnapshot().queued[0].id);
  assert.deepEqual(queue.getSnapshot().queued.map((q) => q.text), ["stay"]);
});

test("edit (take) and remove pull an item out of the queue", () => {
  const { queue } = setup();
  queue.setBusy(true);
  queue.enqueue("a");
  queue.enqueue("b");
  const [a, b] = queue.getSnapshot().queued;
  assert.equal(queue.take(a.id), "a");
  assert.equal(queue.take(a.id), null);
  queue.take(b.id);
  assert.equal(queue.getSnapshot().queued.length, 0);
});

test("recallLast pulls the newest queued item", () => {
  const { queue } = setup();
  queue.setBusy(true);
  queue.enqueue("older");
  queue.enqueue("newest");
  assert.equal(queue.recallLast(), "newest");
  assert.deepEqual(queue.getSnapshot().queued.map((q) => q.text), ["older"]);
  queue.take(queue.getSnapshot().queued[0].id);
  assert.equal(queue.recallLast(), null);
});

test("appendToDraft appends an edited item to a non-empty draft", () => {
  assert.equal(appendToDraft("", "x"), "x");
  assert.equal(appendToDraft("  ", "x"), "x");
  assert.equal(appendToDraft("draft ", "x"), "draft\nx");
});
