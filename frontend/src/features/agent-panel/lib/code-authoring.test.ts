import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

const srcUrl = new URL("../../../", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      return { shortCircuit: true, url: new URL(`${specifier.slice(2)}.ts`, srcUrl).href };
    }
    if (specifier.startsWith(".") && !specifier.endsWith(".ts")) {
      return { shortCircuit: true, url: new URL(`${specifier}.ts`, context.parentURL).href };
    }
    return nextResolve(specifier, context);
  },
});

const { describeFixes, followUpAuthoringGoal, latestToolCallId, panelAuthoringContext } =
  await import(
    "./code-authoring.ts"
  );

test("the latest call of a tool is found across turns", () => {
  const chat = [
    { toolCalls: [{ id: "a", tool: "request_code_authoring" }] },
    { toolCalls: [{ id: "b", tool: "request_code_authoring" }, { id: "c", tool: "set_field" }] },
    {},
  ];
  assert.equal(latestToolCallId(chat, "request_code_authoring"), "b");
  assert.equal(latestToolCallId(chat, "submit"), null);
});

test("only a repeated coding call with a goal becomes a follow-up", () => {
  assert.equal(followUpAuthoringGoal({ goal: "Give 0.25 for extra text" }, false), null);
  assert.equal(
    followUpAuthoringGoal({ goal: "  Give 0.25 for extra text " }, true),
    "Give 0.25 for extra text",
  );
  assert.equal(followUpAuthoringGoal({ goal: "   " }, true), null);
  assert.equal(followUpAuthoringGoal({}, true), null);
});

const fix1 = {
  attempt: 1,
  failures: ["The metric must return a number"],
  runBefore: "run v1",
  metricBefore: "metric v1",
  from: 2,
};

test("a fix stays pending until its turn has sent and finished", () => {
  const notSent = describeFixes([{ ...fix1, from: null }], [], false, "run v1", "metric v1");
  assert.equal(notSent[0].fix, null);
  const chat = [
    { role: "user", content: "write it" },
    { role: "assistant", content: "done" },
    { role: "user", content: "fix it" },
    { role: "assistant", content: "" },
  ];
  assert.equal(describeFixes([fix1], chat, true, "run v1", "metric v2")[0].fix, null);
});

test("a finished fix carries the agent's reply and which code it changed", () => {
  const chat = [
    { role: "user", content: "write it" },
    { role: "assistant", content: "done" },
    { role: "user", content: "fix it" },
    { role: "assistant", content: " Returned a float score. " },
  ];
  const [attempt] = describeFixes([fix1], chat, false, "run v1", "metric v2");
  assert.equal(attempt.attempt, 1);
  assert.deepEqual(attempt.failures, ["The metric must return a number"]);
  assert.deepEqual(attempt.fix, {
    reply: "Returned a float score.",
    runChanged: false,
    metricChanged: true,
  });
});

test("an earlier fix is measured against the code the next check saw", () => {
  const fix2 = { ...fix1, attempt: 2, runBefore: "run v2", metricBefore: "metric v1", from: 4 };
  const chat = [
    { role: "user", content: "write it" },
    { role: "assistant", content: "done" },
    { role: "user", content: "fix it" },
    { role: "assistant", content: "Fixed the run." },
    { role: "user", content: "fix it" },
    { role: "assistant", content: "Fixed the metric." },
  ];
  const [first, second] = describeFixes([fix1, fix2], chat, false, "run v2", "metric v2");
  assert.deepEqual(first.fix, { reply: "Fixed the run.", runChanged: true, metricChanged: false });
  assert.deepEqual(second.fix, {
    reply: "Fixed the metric.",
    runChanged: false,
    metricChanged: true,
  });
});

const dataset = {
  rows: [{ message: "I was charged twice", label: "billing" }],
  columns: ["message", "label"],
  columnRoles: { message: "input", label: "output" } as const,
};

test("panel sample cases key expected by its field, as the run's harness passes it", () => {
  const context = panelAuthoringContext(
    { artifact_kind: "prompt", data_mode: "pairs", task_objective: "Route tickets" },
    dataset,
  );
  assert.deepEqual(context?.sample_cases, [
    { input: { message: "I was charged twice" }, expected: { label: "billing" } },
  ]);
});

test("panel sample cases carry no expected without an expected field", () => {
  const context = panelAuthoringContext(
    { artifact_kind: "prompt", data_mode: "pairs", task_objective: "Route tickets" },
    { ...dataset, columnRoles: { message: "input", label: "ignore" } },
  );
  assert.deepEqual(context?.sample_cases, [{ input: { message: "I was charged twice" } }]);
});
