import assert from "node:assert/strict";
import { test } from "node:test";

import { parseScreenNav, runScreenNav, switchScreenChat } from "./screen-agent.ts";

test("each screen starts its own conversation", () => {
  const chats = new Map<string, string>();
  assert.deepEqual(switchScreenChat(chats, null, null, "brief"), { kind: "fresh" });
  assert.deepEqual(switchScreenChat(chats, "brief", "conv-brief", "artifact"), { kind: "fresh" });
  assert.equal(chats.get("brief"), "conv-brief");
});

test("going back resumes the earlier screen's conversation", () => {
  const chats = new Map<string, string>();
  switchScreenChat(chats, "brief", "conv-brief", "artifact");
  assert.deepEqual(switchScreenChat(chats, "artifact", "conv-artifact", "brief"), {
    kind: "resume",
    conversationId: "conv-brief",
  });
  assert.deepEqual(switchScreenChat(chats, "brief", "conv-brief", "artifact"), {
    kind: "resume",
    conversationId: "conv-artifact",
  });
});

test("staying on a screen keeps its chat, and an unused chat is not remembered", () => {
  const chats = new Map<string, string>();
  assert.deepEqual(switchScreenChat(chats, "brief", "conv-brief", "brief"), { kind: "stay" });
  switchScreenChat(chats, "artifact", null, "brief");
  assert.equal(chats.has("artifact"), false);
});

test("a continue result runs the Continue button's own handler", () => {
  const calls: string[] = [];
  const navigator = {
    screen: "brief",
    forward: () => calls.push("forward"),
    goToScreen: (s: string) => calls.push(`go:${s}`),
  };
  const nav = parseScreenNav({ screen_nav: { action: "continue", from: "brief" } });
  assert.deepEqual(nav, { action: "continue", from: "brief" });
  runScreenNav(nav!, navigator);
  assert.deepEqual(calls, ["forward"]);
});

test("a back result jumps to the named screen with its request", () => {
  const calls: string[] = [];
  const navigator = {
    screen: "budget",
    forward: () => calls.push("forward"),
    goToScreen: (s: string) => calls.push(`go:${s}`),
  };
  const nav = parseScreenNav({
    screen_nav: { action: "back", from: "budget", screen: "brief", request: "refunds" },
  });
  assert.deepEqual(nav, { action: "back", from: "budget", screen: "brief", request: "refunds" });
  runScreenNav(nav!, navigator);
  assert.deepEqual(calls, ["go:brief"]);
});

test("results without a move do nothing", () => {
  assert.equal(parseScreenNav({ wizard_state: { screen_notes: [] } }), null);
  assert.equal(parseScreenNav("Can't continue yet"), null);
  assert.equal(parseScreenNav({ screen_nav: { action: "back", screen: "" } }), null);
  runScreenNav({ action: "continue", from: "brief" }, null);
});

test("a continue from a screen the wizard already left is dropped", () => {
  const calls: string[] = [];
  const navigator = {
    screen: "artifact",
    forward: () => calls.push("forward"),
    goToScreen: (s: string) => calls.push(`go:${s}`),
  };
  runScreenNav({ action: "continue", from: "brief" }, navigator);
  assert.deepEqual(calls, []);
});
