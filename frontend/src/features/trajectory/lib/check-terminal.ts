// The Check's live log arrives as one flat stream of events for all three
// rows. The pop-up shows one row at a time, and inside the evaluator each
// concurrent sample on its own, so these helpers fold the stream into what
// one view needs. They are pure, so they run on every streamed event.

import type { CheckTerminalEvent, CheckTerminalPhase } from "@/shared/types/unified-run";

export type SampleState = "queued" | "running" | "done" | "failed";

export interface SampleLane {
  index: number;
  state: SampleState;
  startedAt?: number;
  finishedAt?: number;
  score?: number;
  error?: string;
}

export interface TerminalCommand {
  id: number;
  label: string;
  sample?: number;
  startedAt: number;
  lines: Array<{ stream: "stdout" | "stderr" | "log"; text: string }>;
  /** How the command ended; absent while it runs. */
  exit?: { durationMs: number; exitCode?: number; timedOut?: boolean; error?: string };
}

/** One entry of a phase's terminal: a host milestone or a command with its output. */
export type TerminalEntry =
  | {
      kind: "note";
      t: number;
      note: string;
      params?: Record<string, string | number>;
      sample?: number;
    }
  | { kind: "command"; t: number; command: TerminalCommand };

export function eventsOfPhase(
  events: readonly CheckTerminalEvent[],
  phase: CheckTerminalPhase,
): CheckTerminalEvent[] {
  return events.filter((event) => event.phase === phase);
}

/** Group a phase's events into notes and commands, each command holding its own output. */
export function terminalEntries(events: readonly CheckTerminalEvent[]): TerminalEntry[] {
  const entries: TerminalEntry[] = [];
  const commands = new Map<number, TerminalCommand>();
  for (const event of events) {
    if (event.kind === "note") {
      entries.push({
        kind: "note",
        t: event.t,
        note: event.note,
        params: event.params,
        sample: event.sample,
      });
    } else if (event.kind === "command") {
      const command: TerminalCommand = {
        id: event.id,
        label: event.label,
        sample: event.sample,
        startedAt: event.t,
        lines: [],
      };
      commands.set(event.id, command);
      entries.push({ kind: "command", t: event.t, command });
    } else if (event.kind === "output") {
      commands.get(event.id)?.lines.push({ stream: event.stream, text: event.text });
    } else if (event.kind === "exit") {
      const command = commands.get(event.id);
      if (command)
        command.exit = {
          durationMs: event.duration_ms,
          exitCode: event.exit_code,
          timedOut: event.timed_out,
          error: event.error,
        };
    }
  }
  return entries;
}

/** Each evaluator sample's latest state, in sample order; samples announced but not yet started read as queued. */
export function sampleLanes(events: readonly CheckTerminalEvent[]): SampleLane[] {
  const lanes = new Map<number, SampleLane>();
  let total = 0;
  for (const event of events) {
    if (event.kind !== "sample" || event.sample === undefined) continue;
    total = Math.max(total, event.total);
    const lane = lanes.get(event.sample) ?? { index: event.sample, state: "queued" };
    if (event.state === "running") {
      lane.state = "running";
      lane.startedAt = event.t;
    } else {
      lane.state = event.state;
      lane.finishedAt = event.t;
      lane.score = event.score;
      lane.error = event.error;
    }
    lanes.set(event.sample, lane);
  }
  for (let index = 0; index < total; index += 1)
    if (!lanes.has(index)) lanes.set(index, { index, state: "queued" });
  return [...lanes.values()].sort((a, b) => a.index - b.index);
}

/** How many samples have finished out of how many run, or null before the evaluator starts any. */
export function sampleProgress(
  events: readonly CheckTerminalEvent[],
): { done: number; total: number } | null {
  const lanes = sampleLanes(events);
  if (lanes.length === 0) return null;
  const done = lanes.filter((lane) => lane.state === "done" || lane.state === "failed").length;
  return { done, total: lanes.length };
}

/** The log as plain text, for the copy button; notes are worded by `note`. */
export function terminalText(
  entries: readonly TerminalEntry[],
  note: (entry: Extract<TerminalEntry, { kind: "note" }>) => string,
): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.kind === "note") {
      lines.push(`# ${note(entry)}`);
      continue;
    }
    const { command } = entry;
    lines.push(`$ ${command.label}`);
    for (const line of command.lines) lines.push(line.text);
    if (command.exit) {
      const code = command.exit.exitCode;
      lines.push(
        `[exit ${code ?? command.exit.error ?? "?"} · ${(command.exit.durationMs / 1000).toFixed(1)}s]`,
      );
    }
  }
  return lines.join("\n");
}
