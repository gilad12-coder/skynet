import { test } from "node:test";
import assert from "node:assert/strict";

import { chromeCellAction, shouldSyncPush, vapidKeyBytes } from "./push-state.ts";

test("vapidKeyBytes decodes urlsafe base64 without padding", () => {
  const bytes = new Uint8Array([0xfb, 0xff, 0xbf, 0x04, 0x41]);
  const key = Buffer.from(bytes).toString("base64url");
  assert.ok(!key.includes("=") && /[-_]/.test(key));
  assert.deepEqual([...vapidKeyBytes(key)], [...bytes]);
});

test("vapidKeyBytes keeps the 65-byte uncompressed point length", () => {
  const point = new Uint8Array(65).fill(7);
  point[0] = 4;
  assert.equal(vapidKeyBytes(Buffer.from(point).toString("base64url")).length, 65);
});

test("a run start re-saves the subscription only where the browser already granted", () => {
  assert.equal(shouldSyncPush("granted"), true);
  assert.equal(shouldSyncPush("default"), false);
  assert.equal(shouldSyncPush("denied"), false);
  assert.equal(shouldSyncPush("unsupported"), false);
});

test("a chrome cell subscribes first unless already subscribed or blocked", () => {
  assert.equal(chromeCellAction("default", false), "subscribe");
  assert.equal(chromeCellAction("granted", false), "subscribe");
  assert.equal(chromeCellAction("granted", true), "save");
  assert.equal(chromeCellAction("denied", true), "blocked");
  assert.equal(chromeCellAction("unsupported", false), "unsupported");
});
