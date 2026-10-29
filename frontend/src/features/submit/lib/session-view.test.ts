import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

import { decodeCodingChat, reopenedPage } from "./session-state.ts";

const unifiedRunUrl = new URL("../../../shared/types/unified-run.ts", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/shared/types/unified-run") {
      return { shortCircuit: true, url: unifiedRunUrl };
    }
    return nextResolve(specifier, context);
  },
});

const { initialWizardV2State } = await import("./wizard-v2.ts");
const { stepPages } = await import("./wizard-pages.ts");

test("a reload reopens the screen it was left on inside the step", () => {
  const state = {
    ...initialWizardV2State("guided"),
    step: "metric" as const,
    furthestStep: "metric" as const,
  };
  const screens = stepPages("metric", state);
  assert.equal(screens[reopenedPage(screens, "check")], "check");
  assert.equal(screens[reopenedPage(screens, "overview")], "overview");
  // A screen the step no longer has, or none saved, opens the step's first.
  assert.equal(reopenedPage(screens, "budget"), 0);
  assert.equal(reopenedPage(screens, null), 0);
});

test("the coding agent's chat comes back whole, and a broken one starts fresh", () => {
  const chat = [
    { role: "user", content: "Write the metric", hidden: true },
    { role: "assistant", content: "Done.", toolCalls: [{ id: "1", name: "write_file" }] },
  ];
  assert.deepEqual(decodeCodingChat(JSON.stringify(chat)), chat);
  assert.deepEqual(decodeCodingChat(null), []);
  assert.deepEqual(decodeCodingChat("{not json"), []);
  assert.deepEqual(decodeCodingChat(JSON.stringify({ role: "user" })), []);
  assert.deepEqual(decodeCodingChat(JSON.stringify([{ role: "system", content: "x" }])), []);
});

test("a tool call a stopped turn left running comes back failed, not spinning", () => {
  const chat = [
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "1", tool: "write_file", status: "done" },
        { id: "2", tool: "verify_code", status: "running" },
      ],
    },
  ];
  const [message] = decodeCodingChat(JSON.stringify(chat));
  assert.deepEqual(
    message?.toolCalls?.map((call) => call.status),
    ["done", "error"],
  );
});
