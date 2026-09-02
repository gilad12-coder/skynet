/**
 * Turn an agent run's raw transcript into blocks the run view can lay out.
 *
 * The transcript is the harness's stdout and stderr as the box produced them:
 * the runner's own `[step] started` / `[step] exit=N` lines, the harness's JSON
 * event stream (pi's `--mode json`, codex's `--json`, claude's
 * `--output-format json`) and whatever else the box printed. Anything not
 * recognised stays as raw text, so nothing the box wrote is lost.
 */

export type TranscriptStep = "install" | "setup" | "run" | "check";

export interface StepBlock {
  kind: "step";
  step: TranscriptStep;
  /** `null` while the step is still running. */
  exitCode: number | null;
  timedOut: boolean;
}

export interface RawBlock {
  kind: "raw";
  text: string;
}

export interface PromptBlock {
  kind: "prompt";
  text: string;
}

export interface ThinkingPart {
  kind: "thinking";
  text: string;
}

export interface TextPart {
  kind: "text";
  text: string;
}

export interface ToolPart {
  kind: "tool";
  id: string;
  name: string;
  args: Record<string, unknown>;
  result: string | null;
  isError: boolean;
  done: boolean;
}

export type TurnPart = ThinkingPart | TextPart | ToolPart;

/** A note the store or the runner left in the stream, not something the box printed. */
export interface NoticeBlock {
  kind: "notice";
  /** `cut`: the head was trimmed away. `capped`: the live stream stopped at its limit. */
  note: "cut" | "capped";
}

export interface TurnBlock {
  kind: "turn";
  index: number;
  model: string | null;
  parts: TurnPart[];
  tokens: number | null;
  /** The harness has not closed the message yet. */
  pending: boolean;
}

export type TranscriptBlock = StepBlock | RawBlock | PromptBlock | TurnBlock | NoticeBlock;

type Json = Record<string, unknown>;

interface ParseState {
  blocks: TranscriptBlock[];
  turns: number;
  current: TurnBlock | null;
}

const STEP_LINE = /^\[(install|setup|run|check)\] (?:started|exit=(-?\d+)( \(timed out\))?)$/;
const TRUNCATION_MARK = "…";
// The recorder's own line when a run outgrows what it streams live.
const STREAM_CAPPED_LINE = "[transcript] live stream capped; the rest arrives when the run ends";

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Join the text pieces of a harness `content` list. */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((piece) => (isRecord(piece) && piece.type === "text" ? (str(piece.text) ?? "") : ""))
    .filter((piece) => piece.length > 0)
    .join("\n");
}

function tokensOf(usage: unknown): number | null {
  if (!isRecord(usage)) return null;
  const total = num(usage.totalTokens);
  if (total !== null) return total;
  const input = num(usage.input) ?? num(usage.input_tokens);
  const output = num(usage.output) ?? num(usage.output_tokens);
  if (input === null && output === null) return null;
  return (input ?? 0) + (output ?? 0);
}

function appendRaw(state: ParseState, line: string): void {
  const last = state.blocks[state.blocks.length - 1];
  if (last !== undefined && last.kind === "raw") {
    last.text += `\n${line}`;
  } else if (line.length > 0) {
    state.blocks.push({ kind: "raw", text: line });
  }
}

function openTurn(state: ParseState, model: string | null): TurnBlock {
  const turn: TurnBlock = {
    kind: "turn",
    index: state.turns + 1,
    model,
    parts: [],
    tokens: null,
    pending: true,
  };
  state.turns += 1;
  state.blocks.push(turn);
  state.current = turn;
  return turn;
}

function closeTurn(state: ParseState, turn: TurnBlock, tokens: number | null): void {
  turn.pending = false;
  if (tokens !== null) turn.tokens = tokens;
  if (state.current === turn) state.current = null;
}

function currentTurn(state: ParseState, model: string | null = null): TurnBlock {
  return state.current ?? openTurn(state, model);
}

/** The turn tool events attach to: the open one, else the last one. */
function lastTurn(state: ParseState): TurnBlock {
  if (state.current !== null) return state.current;
  for (let i = state.blocks.length - 1; i >= 0; i -= 1) {
    const block = state.blocks[i];
    if (block !== undefined && block.kind === "turn") return block;
  }
  return openTurn(state, null);
}

function findTool(state: ParseState, id: string): ToolPart | null {
  if (id.length === 0) return null;
  for (let i = state.blocks.length - 1; i >= 0; i -= 1) {
    const block = state.blocks[i];
    if (block === undefined || block.kind !== "turn") continue;
    for (const part of block.parts) {
      if (part.kind === "tool" && part.id === id) return part;
    }
  }
  return null;
}

function toolPart(id: string, name: string, args: unknown): ToolPart {
  return {
    kind: "tool",
    id,
    name,
    args: isRecord(args) ? args : {},
    result: null,
    isError: false,
    done: false,
  };
}

function toolFromCall(call: unknown, previous: ToolPart | null): ToolPart {
  const record = isRecord(call) ? call : {};
  const part = toolPart(str(record.id) ?? "", str(record.name) ?? "", record.arguments);
  if (previous !== null) {
    part.result = previous.result;
    part.isError = previous.isError;
    part.done = previous.done;
  }
  return part;
}

/** Set the part at the harness's content index, filling the slot in order. */
function setPart(turn: TurnBlock, index: number, part: TurnPart): void {
  if (index >= 0 && index < turn.parts.length) turn.parts[index] = part;
  else turn.parts.push(part);
}

function partAt(turn: TurnBlock, index: number): TurnPart | undefined {
  return index >= 0 && index < turn.parts.length ? turn.parts[index] : undefined;
}

function onAssistantEvent(state: ParseState, event: Json): void {
  const turn = currentTurn(state);
  const index = num(event.contentIndex) ?? turn.parts.length;
  const type = event.type;
  if (type === "thinking_start" || type === "text_start") {
    setPart(turn, index, { kind: type === "thinking_start" ? "thinking" : "text", text: "" });
  } else if (type === "thinking_delta" || type === "text_delta") {
    const kind = type === "thinking_delta" ? "thinking" : "text";
    const part = partAt(turn, index);
    if (part !== undefined && part.kind === kind) part.text += str(event.delta) ?? "";
    else setPart(turn, index, { kind, text: str(event.delta) ?? "" });
  } else if (type === "thinking_end" || type === "text_end") {
    const kind = type === "thinking_end" ? "thinking" : "text";
    const full = str(event.content);
    const part = partAt(turn, index);
    if (part !== undefined && part.kind === kind) {
      if (full !== null) part.text = full;
    } else {
      setPart(turn, index, { kind, text: full ?? "" });
    }
  } else if (type === "toolcall_start") {
    setPart(turn, index, toolPart("", "", {}));
  } else if (type === "toolcall_end") {
    const part = partAt(turn, index);
    setPart(turn, index, toolFromCall(event.toolCall, part?.kind === "tool" ? part : null));
  }
}

function onMessageStart(state: ParseState, message: unknown): boolean {
  if (!isRecord(message)) return false;
  const role = message.role;
  if (role === "user") {
    state.blocks.push({ kind: "prompt", text: textOf(message.content) });
    return true;
  }
  if (role === "assistant") {
    openTurn(state, str(message.model));
    return true;
  }
  // Tool results arrive as their own message too; `tool_execution_end` already carried them.
  return role === "toolResult";
}

function onMessageEnd(state: ParseState, message: unknown): boolean {
  if (!isRecord(message)) return false;
  const role = message.role;
  if (role !== "assistant") return role === "user" || role === "toolResult";
  const turn = currentTurn(state, str(message.model));
  if (turn.model === null) turn.model = str(message.model);
  const content = Array.isArray(message.content) ? message.content : [];
  const parts: TurnPart[] = [];
  for (const piece of content) {
    if (!isRecord(piece)) continue;
    if (piece.type === "thinking")
      parts.push({ kind: "thinking", text: str(piece.thinking) ?? "" });
    else if (piece.type === "text") parts.push({ kind: "text", text: str(piece.text) ?? "" });
    else if (piece.type === "toolCall") {
      const id = str(piece.id) ?? "";
      const previous = turn.parts.find((part) => part.kind === "tool" && part.id === id);
      parts.push(toolFromCall(piece, previous?.kind === "tool" ? previous : null));
    }
  }
  if (parts.length > 0 || content.length > 0) turn.parts = parts;
  closeTurn(state, turn, tokensOf(message.usage));
  return true;
}

function onToolExecution(state: ParseState, event: Json): void {
  const id = str(event.toolCallId) ?? "";
  let tool = findTool(state, id);
  if (tool === null) {
    if (event.type === "tool_execution_update") return;
    tool = toolPart(id, str(event.toolName) ?? "", event.args);
    lastTurn(state).parts.push(tool);
  }
  if (event.type === "tool_execution_start") {
    if (tool.name.length === 0) tool.name = str(event.toolName) ?? "";
    if (Object.keys(tool.args).length === 0 && isRecord(event.args)) tool.args = event.args;
    tool.done = false;
    return;
  }
  const payload = event.type === "tool_execution_update" ? event.partialResult : event.result;
  const text = isRecord(payload) ? textOf(payload.content) : "";
  if (event.type === "tool_execution_update") {
    if (text.length > 0) tool.result = text;
    return;
  }
  tool.result = text;
  tool.isError = event.isError === true;
  tool.done = true;
}

/** Codex's `--json` items: reasoning, replies and shell commands, each with an id. */
function onCodexItem(state: ParseState, event: Json): boolean {
  const item = event.item;
  if (!isRecord(item)) return false;
  const completed = event.type === "item.completed";
  const kind = item.type;
  if (kind === "reasoning" || kind === "agent_message") {
    if (!completed) return true;
    currentTurn(state).parts.push({
      kind: kind === "reasoning" ? "thinking" : "text",
      text: str(item.text) ?? "",
    });
    return true;
  }
  if (kind === "command_execution") {
    const id = str(item.id) ?? "";
    let tool = findTool(state, id);
    if (tool === null) {
      tool = toolPart(id, "bash", { command: str(item.command) ?? "" });
      currentTurn(state).parts.push(tool);
    }
    if (completed) {
      tool.result = str(item.aggregated_output) ?? "";
      const exitCode = num(item.exit_code);
      tool.isError = exitCode !== null && exitCode !== 0;
      tool.done = true;
    }
    return true;
  }
  return false;
}

function onEvent(state: ParseState, event: Json): boolean {
  switch (event.type) {
    case "session":
    case "turn_start":
    case "turn_end":
    case "agent_start":
    case "agent_end":
    case "agent_settled":
    case "thread.started":
    case "system":
      return true;
    case "message_start":
      return onMessageStart(state, event.message);
    case "message_update":
      if (!isRecord(event.assistantMessageEvent)) return false;
      onAssistantEvent(state, event.assistantMessageEvent);
      return true;
    case "message_end":
      return onMessageEnd(state, event.message);
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
      onToolExecution(state, event);
      return true;
    case "item.started":
    case "item.completed":
      return onCodexItem(state, event);
    case "turn.started":
      openTurn(state, null);
      return true;
    case "turn.completed":
      closeTurn(state, currentTurn(state), tokensOf(event.usage));
      return true;
    case "result": {
      const text = str(event.result);
      if (text === null) return false;
      const turn = currentTurn(state);
      turn.parts.push({ kind: "text", text });
      closeTurn(state, turn, tokensOf(event.usage));
      return true;
    }
    default:
      return false;
  }
}

function onStepLine(
  state: ParseState,
  step: TranscriptStep,
  exit: string | undefined,
  timedOut: boolean,
): void {
  if (exit === undefined) {
    state.blocks.push({ kind: "step", step, exitCode: null, timedOut: false });
    return;
  }
  const exitCode = Number.parseInt(exit, 10);
  for (let i = state.blocks.length - 1; i >= 0; i -= 1) {
    const block = state.blocks[i];
    if (
      block !== undefined &&
      block.kind === "step" &&
      block.step === step &&
      block.exitCode === null
    ) {
      block.exitCode = exitCode;
      block.timedOut = timedOut;
      return;
    }
  }
  state.blocks.push({ kind: "step", step, exitCode, timedOut });
}

function consumeLine(state: ParseState, line: string): void {
  if (line === STREAM_CAPPED_LINE) {
    state.blocks.push({ kind: "notice", note: "capped" });
    return;
  }
  const step = STEP_LINE.exec(line);
  if (step !== null) {
    onStepLine(state, step[1] as TranscriptStep, step[2], step[3] !== undefined);
    return;
  }
  if (line.startsWith("{") && line.endsWith("}")) {
    let event: unknown = null;
    try {
      event = JSON.parse(line);
    } catch {
      event = null;
    }
    if (isRecord(event) && onEvent(state, event)) return;
  }
  appendRaw(state, line);
}

/**
 * Parse a transcript into blocks.
 *
 * While the run is live the transcript may end mid-line; that line is left out
 * until the rest of it arrives. A transcript that outgrew the store keeps its
 * tail behind a leading `…`; the cut first line is dropped with it.
 */
export function parseTranscript(transcript: string, live: boolean): TranscriptBlock[] {
  const state: ParseState = { blocks: [], turns: 0, current: null };
  let lines = transcript.split("\n");
  if (transcript.startsWith(TRUNCATION_MARK)) {
    state.blocks.push({ kind: "notice", note: "cut" });
    lines = lines.slice(1);
  }
  const tail = lines.pop();
  if (tail !== undefined && tail.length > 0 && !live) lines.push(tail);
  for (const line of lines) consumeLine(state, line);
  for (const block of state.blocks) {
    if (block.kind === "raw") block.text = block.text.replace(/\s+$/, "");
  }
  return state.blocks.filter((block) => block.kind !== "raw" || block.text.length > 0);
}
