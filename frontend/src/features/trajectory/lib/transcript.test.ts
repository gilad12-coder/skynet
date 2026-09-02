import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseTranscript, type TurnBlock } from "./transcript.ts";

function line(event: Record<string, unknown>): string {
  return JSON.stringify(event);
}

function assistantStart(model = "deepseek/deepseek-v4-flash-0731"): string {
  return line({
    type: "message_start",
    message: { role: "assistant", content: [], model, usage: {}, stopReason: "pending" },
  });
}

function update(assistantMessageEvent: Record<string, unknown>): string {
  return line({ type: "message_update", assistantMessageEvent });
}

function turn(blocks: ReturnType<typeof parseTranscript>, index: number): TurnBlock {
  const block = blocks.find((b) => b.kind === "turn" && b.index === index);
  assert.ok(block !== undefined && block.kind === "turn", `turn ${index} missing`);
  return block;
}

describe("parseTranscript", () => {
  it("marks the runner's steps and closes them with their exit line", () => {
    const blocks = parseTranscript(
      "[install] started\n0.84.1\n[install] exit=0\n[run] started\n[run] exit=124 (timed out)\n",
      false,
    );
    assert.deepEqual(
      blocks,
      [
        { kind: "step", step: "install", exitCode: null, timedOut: false },
        { kind: "raw", text: "0.84.1" },
        { kind: "step", step: "run", exitCode: 124, timedOut: true },
      ].map((b, i) => (i === 0 ? { ...b, exitCode: 0 } : b)),
    );
  });

  it("keeps an exit line whose start was cut away", () => {
    const blocks = parseTranscript("…json tail}\n[run] exit=1\n", false);
    assert.deepEqual(blocks, [
      { kind: "notice", note: "cut" },
      { kind: "step", step: "run", exitCode: 1, timedOut: false },
    ]);
  });

  it("turns the recorder's capped-stream line into a notice", () => {
    const blocks = parseTranscript(
      "[run] started\n[transcript] live stream capped; the rest arrives when the run ends\n",
      true,
    );
    assert.deepEqual(blocks, [
      { kind: "step", step: "run", exitCode: null, timedOut: false },
      { kind: "notice", note: "capped" },
    ]);
  });

  it("builds a pi turn from its deltas and replaces it with the closed message", () => {
    const transcript = [
      line({ type: "session", version: 3, id: "s", cwd: "/vercel" }),
      line({
        type: "message_start",
        message: { role: "user", content: [{ type: "text", text: "Write the script." }] },
      }),
      line({ type: "agent_start" }),
      line({ type: "turn_start" }),
      assistantStart(),
      update({ type: "thinking_start", contentIndex: 0 }),
      update({ type: "thinking_delta", contentIndex: 0, delta: "Let me " }),
      update({ type: "thinking_delta", contentIndex: 0, delta: "look." }),
      update({ type: "thinking_end", contentIndex: 0, content: "Let me look." }),
      update({ type: "text_start", contentIndex: 1 }),
      update({ type: "text_delta", contentIndex: 1, delta: "Checking the env." }),
      update({ type: "text_end", contentIndex: 1, content: "Checking the env." }),
      update({ type: "toolcall_start", contentIndex: 2 }),
      update({ type: "toolcall_delta", contentIndex: 2, delta: '{"command":' }),
      update({
        type: "toolcall_end",
        contentIndex: 2,
        toolCall: { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
      }),
      line({
        type: "message_end",
        message: {
          role: "assistant",
          model: "deepseek/deepseek-v4-flash-0731",
          content: [
            { type: "thinking", thinking: "Let me look." },
            { type: "text", text: "Checking the env." },
            { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
          ],
          usage: { input: 398, output: 275, totalTokens: 10145 },
          stopReason: "stop",
        },
      }),
      line({
        type: "tool_execution_start",
        toolCallId: "call_1",
        toolName: "bash",
        args: { command: "ls" },
      }),
      line({
        type: "tool_execution_update",
        toolCallId: "call_1",
        toolName: "bash",
        args: { command: "ls" },
        partialResult: { content: [] },
      }),
      line({
        type: "tool_execution_end",
        toolCallId: "call_1",
        toolName: "bash",
        result: { content: [{ type: "text", text: "AGENTS.md\n" }] },
        isError: false,
      }),
      line({
        type: "message_start",
        message: {
          role: "toolResult",
          toolCallId: "call_1",
          content: [{ type: "text", text: "AGENTS.md\n" }],
        },
      }),
      line({ type: "turn_end" }),
      line({ type: "agent_end", messages: [] }),
      line({ type: "agent_settled" }),
      "",
    ].join("\n");
    const blocks = parseTranscript(transcript, false);
    assert.deepEqual(
      blocks.map((b) => b.kind),
      ["prompt", "turn"],
    );
    assert.deepEqual(blocks[0], { kind: "prompt", text: "Write the script." });
    const first = turn(blocks, 1);
    assert.equal(first.pending, false);
    assert.equal(first.tokens, 10145);
    assert.equal(first.model, "deepseek/deepseek-v4-flash-0731");
    assert.deepEqual(first.parts, [
      { kind: "thinking", text: "Let me look." },
      { kind: "text", text: "Checking the env." },
      {
        kind: "tool",
        id: "call_1",
        name: "bash",
        args: { command: "ls" },
        result: "AGENTS.md\n",
        isError: false,
        done: true,
      },
    ]);
  });

  it("streams a live turn: open parts, a running tool, and no half line", () => {
    const transcript = [
      assistantStart(),
      update({ type: "thinking_start", contentIndex: 0 }),
      update({ type: "thinking_delta", contentIndex: 0, delta: "Hmm" }),
      update({ type: "thinking_end", contentIndex: 0, content: "Hmm" }),
      update({
        type: "toolcall_end",
        contentIndex: 1,
        toolCall: {
          type: "toolCall",
          id: "call_9",
          name: "bash",
          arguments: { command: "sleep 5" },
        },
      }),
      line({
        type: "tool_execution_start",
        toolCallId: "call_9",
        toolName: "bash",
        args: { command: "sleep 5" },
      }),
      line({
        type: "tool_execution_update",
        toolCallId: "call_9",
        toolName: "bash",
        args: {},
        partialResult: { content: [{ type: "text", text: "tick" }] },
      }),
      '{"type":"tool_execution_up',
    ].join("\n");
    const blocks = parseTranscript(transcript, true);
    assert.equal(blocks.length, 1);
    const live = turn(blocks, 1);
    assert.equal(live.pending, true);
    assert.equal(live.tokens, null);
    assert.deepEqual(live.parts, [
      { kind: "thinking", text: "Hmm" },
      {
        kind: "tool",
        id: "call_9",
        name: "bash",
        args: { command: "sleep 5" },
        result: "tick",
        isError: false,
        done: false,
      },
    ]);
  });

  it("keeps a finished run's unterminated last line and merges raw text", () => {
    const blocks = parseTranscript("[run] started\nline one\n\nline two\nnot json {", false);
    assert.deepEqual(blocks, [
      { kind: "step", step: "run", exitCode: null, timedOut: false },
      { kind: "raw", text: "line one\n\nline two\nnot json {" },
    ]);
  });

  it("leaves unknown JSON as raw text", () => {
    const blocks = parseTranscript('{"type":"mystery","x":1}\n{"broken":\n', false);
    assert.deepEqual(blocks, [{ kind: "raw", text: '{"type":"mystery","x":1}\n{"broken":' }]);
  });

  it("attaches a tool result that has no matching call to the last turn", () => {
    const transcript = [
      assistantStart(),
      line({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          usage: { input: 1, output: 2 },
        },
      }),
      line({
        type: "tool_execution_end",
        toolCallId: "call_x",
        toolName: "read",
        result: { content: [{ type: "text", text: "contents" }] },
        isError: true,
      }),
      "",
    ].join("\n");
    const only = turn(parseTranscript(transcript, false), 1);
    assert.equal(only.tokens, 3);
    assert.deepEqual(only.parts[1], {
      kind: "tool",
      id: "call_x",
      name: "read",
      args: {},
      result: "contents",
      isError: true,
      done: true,
    });
  });

  it("reads codex items and claude's single result", () => {
    const codex = [
      line({ type: "thread.started", thread_id: "t" }),
      line({ type: "turn.started" }),
      line({
        type: "item.started",
        item: { id: "i1", type: "command_execution", command: "pytest -q" },
      }),
      line({ type: "item.completed", item: { id: "i0", type: "reasoning", text: "Plan." } }),
      line({
        type: "item.completed",
        item: {
          id: "i1",
          type: "command_execution",
          command: "pytest -q",
          aggregated_output: "1 passed",
          exit_code: 0,
        },
      }),
      line({ type: "item.completed", item: { id: "i2", type: "agent_message", text: "Done." } }),
      line({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }),
      "",
    ].join("\n");
    const codexTurn = turn(parseTranscript(codex, false), 1);
    assert.equal(codexTurn.pending, false);
    assert.equal(codexTurn.tokens, 15);
    assert.deepEqual(
      codexTurn.parts.map((p) => p.kind),
      ["tool", "thinking", "text"],
    );
    assert.equal(
      codexTurn.parts[0]?.kind === "tool" ? codexTurn.parts[0].result : null,
      "1 passed",
    );

    const claude =
      line({ type: "result", result: "All set.", usage: { input_tokens: 7, output_tokens: 1 } }) +
      "\n";
    const claudeTurn = turn(parseTranscript(claude, false), 1);
    assert.deepEqual(claudeTurn.parts, [{ kind: "text", text: "All set." }]);
    assert.equal(claudeTurn.tokens, 8);
  });
});
