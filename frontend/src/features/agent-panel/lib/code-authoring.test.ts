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

const {
  authoringBusy,
  authoringEdits,
  authoringOutcome,
  authoringThinking,
  describeFixes,
  liveAuthoringView,
  outcomeAuthoringView,
  outcomeHistoryResult,
  outcomeLine,
  parseAuthoringOutcome,
  withAuthoringState,
  followUpAuthoringGoal,
  latestToolCallId,
  panelAuthoringContext,
} = await import("./code-authoring.ts");

test("version histories become edits in the order they landed, skipping repeats", () => {
  const run = [
    { code: "a", ts: 1 },
    { code: "a", ts: 4 },
    { code: "b", ts: 5 },
  ];
  const metric = [{ code: "m", ts: 2 }];
  assert.deepEqual(authoringEdits(run, metric), [
    { file: "run", before: "", after: "a", ts: 1 },
    { file: "metric", before: "", after: "m", ts: 2 },
    { file: "run", before: "a", after: "b", ts: 5 },
  ]);
  assert.deepEqual(authoringEdits([], []), []);
});

test("a coding run that streams no reasoning shows no thinking row", () => {
  // The run's timer opens before any token; once the chat turn that started
  // the tool ends, a bare "Thinking" row would still sit over the edit rows.
  assert.equal(
    authoringThinking({
      reasoning: "",
      reasoningStartedAt: 1_000,
      reasoningEndedAt: null,
      status: "streaming",
    }),
    null,
  );
  assert.equal(
    authoringThinking({ reasoning: "", reasoningStartedAt: null, reasoningEndedAt: null, status: "done" }),
    null,
  );
});

test("streamed reasoning shows as thinking, then as a closed thought", () => {
  assert.deepEqual(
    authoringThinking({
      reasoning: "Compare the label",
      reasoningStartedAt: 1_000,
      reasoningEndedAt: null,
      status: "streaming",
    }),
    { reasoning: "Compare the label", startedAt: 1_000, endedAt: null, streaming: true },
  );
  assert.deepEqual(
    authoringThinking({
      reasoning: "Compare the label",
      reasoningStartedAt: 1_000,
      reasoningEndedAt: 4_000,
      status: "done",
    }),
    { reasoning: "Compare the label", startedAt: 1_000, endedAt: 4_000, streaming: false },
  );
});

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

const settled = {
  status: "done",
  error: null,
  checkStatus: "passed",
  signatureValidation: null,
  metricValidation: null,
  signatureVersions: [
    { code: "old", ts: 5 },
    { code: "a\nb", ts: 20 },
  ],
  metricVersions: [{ code: "m", ts: 30 }],
  fixAttempts: [],
  reasoning: "plan",
  reasoningStartedAt: 10,
  reasoningEndedAt: 15,
};

test("a settled run's outcome survives the JSON round trip a reload takes", () => {
  const outcome = authoringOutcome(settled, 10, 99);
  // Edits from an earlier call (ts 5) belong to that call's own rows.
  assert.deepEqual(
    outcome.edits.map((e) => [e.file, e.before, e.after]),
    [
      ["run", "old", "a\nb"],
      ["metric", "", "m"],
    ],
  );
  assert.equal(outcome.check, "passed");
  assert.equal(outcome.endedAt, 99);
  const reloaded = parseAuthoringOutcome(JSON.parse(JSON.stringify(outcome)));
  assert.deepEqual(reloaded, outcome);
  // The rows a reload renders are the rows the live run ended with.
  const live = liveAuthoringView(
    {
      ...settled,
      isWorkflow: false,
      signatureStatus: "done",
      metricStatus: "done",
      signatureFlowing: false,
      metricFlowing: false,
      checkStatus: "passed",
    },
    10,
  );
  const stored = outcomeAuthoringView(reloaded!);
  assert.deepEqual(stored.edits, live.edits);
  assert.equal(stored.check, live.check);
  assert.equal(stored.thinking?.reasoning, live.thinking?.reasoning);
});

test("a missing or malformed outcome parses to null, never to empty rows", () => {
  assert.equal(parseAuthoringOutcome(undefined), null);
  assert.equal(parseAuthoringOutcome({ status: "done" }), null);
  assert.equal(parseAuthoringOutcome("x"), null);
});

test("a failed check keeps its errors; a stopped run is not called done", () => {
  const failed = authoringOutcome(
    { ...settled, checkStatus: "failed", metricValidation: { errors: ["must return a float"] } },
    10,
    99,
  );
  assert.deepEqual(failed.errors, ["must return a float"]);
  assert.equal(authoringOutcome({ ...settled, status: "idle" }, 10, 99).status, "stopped");
});

test("the generalist's history reads how the run ended, with line counts", () => {
  const result = JSON.parse(outcomeHistoryResult(authoringOutcome(settled, 10, 99)));
  assert.deepEqual(result, {
    outcome: {
      status: "done",
      files: [
        { file: "run.py", added: 2, removed: 1 },
        { file: "metric.py", added: 1, removed: 0 },
      ],
      check: "passed",
      errors: [],
    },
  });
  assert.ok(!JSON.stringify(result).includes("now writing"));
});

test("the closing line says what was written and how the check ended", () => {
  const passed = authoringOutcome(settled, 10, 99);
  assert.deepEqual(outcomeLine(passed), { key: "agent.coding_tool.outcome.passed", files: ["run", "metric"] });
  assert.equal(outcomeLine({ ...passed, check: "failed" })?.key, "agent.coding_tool.outcome.failed");
  assert.equal(outcomeLine({ ...passed, check: "none" })?.key, "agent.coding_tool.outcome.unchecked");
  assert.equal(outcomeLine({ ...passed, status: "stopped" })?.key, "agent.coding_tool.outcome.stopped");
  assert.equal(outcomeLine({ ...passed, edits: [] })?.key, "agent.coding_tool.outcome.none");
  assert.equal(outcomeLine({ ...passed, status: "error" }), null);
});

test("a run stays busy until its check and every fix it asked for settled", () => {
  const idle = { status: "done", checkStatus: "passed", fixAttempts: [] };
  assert.equal(authoringBusy(idle), false);
  assert.equal(authoringBusy({ ...idle, status: "streaming" }), true);
  assert.equal(authoringBusy({ ...idle, checkStatus: "checking" }), true);
  assert.equal(authoringBusy({ ...idle, fixAttempts: [{ attempt: 1, failures: [], fix: null }] }), true);
});

test("'Editing <file>' waits for that file's first chunk", () => {
  const base = {
    ...settled,
    status: "streaming",
    isWorkflow: false,
    signatureStatus: "writing",
    metricStatus: "writing",
    signatureFlowing: false,
    metricFlowing: true,
    checkStatus: "idle" as const,
  };
  assert.deepEqual(liveAuthoringView(base).writing, ["metric"]);
  assert.deepEqual(liveAuthoringView({ ...base, signatureFlowing: true }).writing, ["run", "metric"]);
});

test("the running coding call keeps its turn live; a stored one ends where its run ended", () => {
  const call = (id: string, payload?: Record<string, unknown>) => ({
    id,
    tool: "request_code_authoring",
    reason: "",
    status: "done" as const,
    startedAt: 1,
    endedAt: 2,
    payload,
  });
  const stored = authoringOutcome(settled, 0, 500);
  const messages = [
    { toolCalls: [call("a", { outcome: stored })] },
    { toolCalls: [call("b")] },
    { content: "no tools" },
  ];
  const shown = withAuthoringState(messages, "request_code_authoring", "b");
  assert.equal(shown[0]?.toolCalls?.[0]?.endedAt, 500);
  assert.equal(shown[1]?.toolCalls?.[0]?.working, true);
  assert.equal(shown[2], messages[2]);
  assert.equal(withAuthoringState(messages, "request_code_authoring", null)[1]?.toolCalls?.[0]?.working, undefined);
});
