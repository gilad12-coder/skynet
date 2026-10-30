import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CheckTerminalEvent } from "@/shared/types/unified-run";
import {
  eventsOfPhase,
  sampleLanes,
  sampleProgress,
  terminalEntries,
  terminalText,
} from "./check-terminal.ts";

const EVENTS: CheckTerminalEvent[] = [
  { t: 0, phase: "budget", kind: "note", note: "budget_ready", params: { available_cents: 1000 } },
  { t: 10, phase: "sandbox", kind: "note", note: "box_opening" },
  { t: 40, phase: "sandbox", kind: "command", id: 1, label: "pip install pandas" },
  { t: 50, phase: "sandbox", kind: "output", id: 1, stream: "stdout", text: "Collecting pandas" },
  { t: 90, phase: "sandbox", kind: "exit", id: 1, duration_ms: 50, exit_code: 0 },
  { t: 100, phase: "evaluator", kind: "sample", sample: 0, total: 3, state: "running" },
  { t: 101, phase: "evaluator", kind: "sample", sample: 2, total: 3, state: "running" },
  { t: 102, phase: "evaluator", kind: "command", id: 2, label: "python3 harness", sample: 0 },
  {
    t: 150,
    phase: "evaluator",
    kind: "output",
    id: 2,
    stream: "stderr",
    text: "ValueError: bad",
    sample: 0,
  },
  { t: 160, phase: "evaluator", kind: "exit", id: 2, duration_ms: 58, exit_code: 1, sample: 0 },
  {
    t: 161,
    phase: "evaluator",
    kind: "sample",
    sample: 0,
    total: 3,
    state: "failed",
    error: "ValueError: bad",
  },
  { t: 170, phase: "evaluator", kind: "sample", sample: 2, total: 3, state: "done", score: 0.75 },
];

describe("check terminal", () => {
  it("files each event under its own row", () => {
    assert.equal(eventsOfPhase(EVENTS, "budget").length, 1);
    assert.equal(eventsOfPhase(EVENTS, "sandbox").length, 4);
  });

  it("groups a command with its output and exit", () => {
    const entries = terminalEntries(eventsOfPhase(EVENTS, "sandbox"));
    assert.equal(entries.length, 2);
    const command = entries[1];
    assert.ok(command?.kind === "command");
    assert.deepEqual(command.command.lines, [{ stream: "stdout", text: "Collecting pandas" }]);
    assert.equal(command.command.exit?.exitCode, 0);
  });

  it("shows every concurrent sample on its own lane, a not-yet-started one as queued", () => {
    const lanes = sampleLanes(EVENTS);
    assert.deepEqual(
      lanes.map((lane) => lane.state),
      ["failed", "queued", "done"],
    );
    assert.equal(lanes[0]?.error, "ValueError: bad");
    assert.equal(lanes[2]?.score, 0.75);
    assert.deepEqual(sampleProgress(EVENTS), { done: 2, total: 3 });
    assert.equal(sampleProgress(eventsOfPhase(EVENTS, "sandbox")), null);
  });

  it("copies as plain terminal text", () => {
    const text = terminalText(
      terminalEntries(eventsOfPhase(EVENTS, "sandbox")),
      (entry) => entry.note,
    );
    assert.equal(text, "# box_opening\n$ pip install pandas\nCollecting pandas\n[exit 0 · 0.1s]");
  });
});
