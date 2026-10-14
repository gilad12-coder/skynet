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
  contractValidations,
  liveAuthoringView,
  outcomeAuthoringView,
  outcomeHistoryResult,
  outcomeLine,
  parseAuthoringOutcome,
  withAuthoringState,
  followUpAuthoringGoal,
  latestToolCallId,
  panelAuthoringContext,
  panelContractSpec,
} = await import("./code-authoring.ts");

test("version histories become edits in the order they landed, skipping repeats", () => {
  const run = [
    { code: "a", ts: 1 },
    { code: "a", ts: 4 },
    { code: "b", ts: 5 },
  ];
  const metric = [{ code: "m", ts: 2 }];
  assert.deepEqual(authoringEdits(run, metric), [
    { file: "run.py", before: "", after: "a", ts: 1 },
    { file: "metric.py", before: "", after: "m", ts: 2 },
    { file: "run.py", before: "a", after: "b", ts: 5 },
  ]);
  assert.deepEqual(authoringEdits([], []), []);
});

test("an extra file's versions become edits named by its path", () => {
  const edits = authoringEdits([{ code: "r", ts: 1 }], [], {
    "helpers.py": [
      { code: "def f(): ...", ts: 2 },
      { code: "def f(): return 1", ts: 3 },
    ],
  });
  assert.deepEqual(
    edits.map((e) => [e.file, e.before, e.after]),
    [
      ["run.py", "", "r"],
      ["helpers.py", "", "def f(): ..."],
      ["helpers.py", "def f(): ...", "def f(): return 1"],
    ],
  );
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

test("the static check spec carries the extra files only when there are some", () => {
  const context = panelAuthoringContext(
    { artifact_kind: "prompt", data_mode: "pairs", task_objective: "Route tickets" },
    dataset,
  );
  assert.ok(context);
  assert.equal(panelContractSpec(context, "run", "metric").workspace.files, undefined);
  assert.deepEqual(
    panelContractSpec(context, "run", "metric", { "helpers.py": "X = 1" }).workspace.files,
    { "helpers.py": "X = 1" },
  );
});

test("an extra file's failure lands with the run code, which imports it", () => {
  const { run, metric } = contractValidations({
    ok: false,
    checks: [
      { key: "workspace.files", status: "failed", message: "Syntax", detail: "helpers.py: bad" },
      { key: "metric.signature", status: "failed", message: "Metric" },
    ],
  } as never);
  assert.deepEqual(run.errors, ["Syntax helpers.py: bad"]);
  assert.deepEqual(metric.errors, ["Metric"]);
});

const verifyCall = (
  id: string,
  startedAt: number,
  verification?: { ok: boolean; files: Array<{ path: string; ok: boolean; errors: string[] }> },
  status = "done",
) => ({ id, tool: "verify_code", status, startedAt, verification });

const settled = {
  status: "done",
  error: null,
  signatureVersions: [
    { code: "old", ts: 5 },
    { code: "a\nb", ts: 20 },
  ],
  metricVersions: [{ code: "m", ts: 30 }],
  fileVersions: { "helpers.py": [{ code: "X = 1", ts: 35 }] },
  messages: [
    {
      toolCalls: [
        verifyCall("v0", 6, { ok: false, files: [{ path: "run.py", ok: false, errors: ["earlier"] }] }),
        verifyCall("v1", 32, {
          ok: false,
          files: [
            { path: "run.py", ok: true, errors: [] },
            { path: "metric.py", ok: false, errors: ["must return a float"] },
          ],
        }),
        { id: "d1", tool: "delete_file", status: "done", startedAt: 36, path: "old.py" },
        verifyCall("v2", 40, { ok: true, files: [{ path: "metric.py", ok: true, errors: [] }] }),
      ],
    },
  ],
  reasoning: "plan",
  reasoningStartedAt: 10,
  reasoningEndedAt: 15,
};

test("a settled run's outcome survives the JSON round trip a reload takes", () => {
  const outcome = authoringOutcome(settled, 10, 99);
  // Edits and checks from an earlier call (ts 5, 6) belong to that call's own rows.
  assert.deepEqual(
    outcome.edits.map((e) => [e.file, e.before, e.after]),
    [
      ["run.py", "old", "a\nb"],
      ["metric.py", "", "m"],
      ["helpers.py", "", "X = 1"],
    ],
  );
  assert.deepEqual(outcome.deletes, [{ file: "old.py", ts: 36 }]);
  assert.deepEqual(
    outcome.checks.map((c) => [c.id, c.state]),
    [
      ["v1", "failed"],
      ["v2", "passed"],
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
      writingFiles: [],
    },
    10,
  );
  const stored = outcomeAuthoringView(reloaded!);
  assert.deepEqual(stored.edits, live.edits);
  assert.deepEqual(stored.deletes, live.deletes);
  assert.deepEqual(stored.checks, live.checks);
  assert.equal(stored.thinking?.reasoning, live.thinking?.reasoning);
});

test("a failed check lists each failing file's findings and sets the outcome's verdict", () => {
  const messages = [{ toolCalls: [settled.messages[0]!.toolCalls[1]!] }];
  const failed = authoringOutcome({ ...settled, messages }, 10, 99);
  assert.equal(failed.check, "failed");
  assert.deepEqual(failed.checks[0]?.failures, [{ path: "metric.py", errors: ["must return a float"] }]);
  assert.deepEqual(failed.errors, ["metric.py: must return a float"]);
  assert.equal(authoringOutcome({ ...settled, messages: [] }, 10, 99).check, "none");
  assert.equal(authoringOutcome({ ...settled, status: "idle" }, 10, 99).status, "stopped");
});

test("a check still running is shown live but never stored", () => {
  const messages = [{ toolCalls: [verifyCall("v9", 50, undefined, "running")] }];
  const view = liveAuthoringView(
    {
      ...settled,
      messages,
      isWorkflow: false,
      signatureStatus: "done",
      metricStatus: "done",
      signatureFlowing: false,
      metricFlowing: false,
      writingFiles: [],
    },
    10,
  );
  assert.deepEqual(view.checks, [{ id: "v9", ts: 50, state: "running", failures: [] }]);
  const stopped = authoringOutcome({ ...settled, status: "idle", messages }, 10, 99);
  assert.deepEqual(stopped.checks, []);
  assert.equal(stopped.check, "none");
  // An errored check with no result is a failed one with nothing to list.
  const errored = [{ toolCalls: [verifyCall("v8", 50, undefined, "error")] }];
  assert.equal(authoringOutcome({ ...settled, messages: errored }, 10, 99).checks[0]?.state, "failed");
});

test("an outcome stored before extra files and verify_code still renders", () => {
  const legacy = parseAuthoringOutcome({
    status: "done",
    check: "failed",
    errors: ["must return a float"],
    edits: [
      { file: "run", before: "", after: "a", ts: 1 },
      { file: "metric", before: "", after: "m", ts: 2 },
    ],
    fixes: [{ attempt: 1, failures: ["x"], fix: { reply: "", runChanged: true, metricChanged: false } }],
    thinking: null,
    error: null,
    endedAt: 99,
  });
  assert.ok(legacy);
  assert.deepEqual(
    legacy.edits.map((e) => e.file),
    ["run.py", "metric.py"],
  );
  assert.deepEqual(legacy.deletes, []);
  assert.deepEqual(outcomeAuthoringView(legacy).checks, [
    { id: "check", ts: 99, state: "failed", failures: [{ path: "", errors: ["must return a float"] }] },
  ]);
  assert.deepEqual(outcomeLine(legacy), {
    key: "agent.coding_tool.outcome.failed",
    files: ["run.py", "metric.py"],
  });
  assert.deepEqual(outcomeAuthoringView({ ...legacy, check: "none" }).checks, []);
});

test("a missing or malformed outcome parses to null, never to empty rows", () => {
  assert.equal(parseAuthoringOutcome(undefined), null);
  assert.equal(parseAuthoringOutcome({ status: "done" }), null);
  assert.equal(parseAuthoringOutcome("x"), null);
});

test("the generalist's history reads how the run ended, with line counts and deletes", () => {
  const result = JSON.parse(outcomeHistoryResult(authoringOutcome(settled, 10, 99)));
  assert.deepEqual(result, {
    outcome: {
      status: "done",
      files: [
        { file: "run.py", added: 2, removed: 1 },
        { file: "metric.py", added: 1, removed: 0 },
        { file: "helpers.py", added: 1, removed: 0 },
      ],
      deleted: ["old.py"],
      check: "passed",
      errors: [],
    },
  });
  assert.ok(!JSON.stringify(result).includes("now writing"));
});

test("the closing line says what was written and how the last check ended", () => {
  const passed = authoringOutcome(settled, 10, 99);
  assert.deepEqual(outcomeLine(passed), {
    key: "agent.coding_tool.outcome.passed",
    files: ["run.py", "metric.py", "helpers.py"],
  });
  assert.equal(outcomeLine({ ...passed, check: "failed" })?.key, "agent.coding_tool.outcome.failed");
  assert.equal(outcomeLine({ ...passed, check: "none" })?.key, "agent.coding_tool.outcome.unchecked");
  assert.equal(outcomeLine({ ...passed, status: "stopped" })?.key, "agent.coding_tool.outcome.stopped");
  assert.equal(outcomeLine({ ...passed, edits: [], deletes: [] })?.key, "agent.coding_tool.outcome.none");
  // A run that only deleted files says so in its rows, not as "changed no code".
  assert.equal(outcomeLine({ ...passed, edits: [] }), null);
  assert.equal(outcomeLine({ ...passed, status: "error" }), null);
});

test("a run stays busy only while its turn streams", () => {
  assert.equal(authoringBusy({ status: "done" }), false);
  assert.equal(authoringBusy({ status: "streaming" }), true);
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
    writingFiles: [] as string[],
  };
  assert.deepEqual(liveAuthoringView(base).writing, ["metric.py"]);
  assert.deepEqual(liveAuthoringView({ ...base, signatureFlowing: true }).writing, ["run.py", "metric.py"]);
  assert.deepEqual(liveAuthoringView({ ...base, writingFiles: ["helpers.py"] }).writing, [
    "metric.py",
    "helpers.py",
  ]);
  // A workflow run edits a graph: no extra files, deletes or checks.
  const workflow = liveAuthoringView({ ...base, isWorkflow: true, writingFiles: ["helpers.py"] });
  assert.deepEqual(workflow.writing, ["metric.py"]);
  assert.deepEqual([workflow.deletes, workflow.checks], [[], []]);
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
