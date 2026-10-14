/** Tests for packing long pastes into, and out of, a chat message string. */

import assert from "node:assert/strict";
import test from "node:test";

import { joinPastes, shouldAttachPaste, splitPastes } from "./pasted-text.ts";

test("a message without pastes splits to itself", () => {
  assert.deepEqual(splitPastes("hello\nworld"), { text: "hello\nworld", pastes: [] });
});

test("split and join round-trip typed text and several pastes", () => {
  const parts = { text: "summarise these", pastes: ["first\nbrief", "second <b>brief</b>"] };
  assert.deepEqual(splitPastes(joinPastes(parts)), parts);
});

test("a paste with no typed text joins to just the block", () => {
  const joined = joinPastes({ text: "", pastes: ["only"] });
  assert.equal(joined, "<pasted_text>\nonly\n</pasted_text>");
  assert.deepEqual(splitPastes(joined), { text: "", pastes: ["only"] });
});

test("only long pastes become cards", () => {
  assert.equal(shouldAttachPaste("x".repeat(4999)), false);
  assert.equal(shouldAttachPaste("x".repeat(5000)), true);
});
