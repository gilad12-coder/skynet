import assert from "node:assert/strict";
import { test } from "node:test";

import {
  appendReasoning,
  closeThinking,
  interleaveThinking,
  lastEventAt,
  reopenThinking,
  startThinking,
  thoughtSeconds,
  type ThinkingSegment,
} from "./thinking-segments.ts";

test("reasoning, a tool, then reasoning makes two segments with the tool between", () => {
  let segs: readonly ThinkingSegment[] = startThinking([], 0, 0);
  segs = appendReasoning(segs, "Let me ", 1000, 0);
  segs = appendReasoning(segs, "look.", 2000, 0);
  segs = closeThinking(segs, 4000);
  segs = appendReasoning(segs, "Found it.", 6000, 1);
  segs = closeThinking(segs, 9000);
  assert.deepEqual(segs, [
    { reasoning: "Let me look.", startedAt: 1000, endedAt: 4000, toolsBefore: 0 },
    { reasoning: "Found it.", startedAt: 6000, endedAt: 9000, toolsBefore: 1 },
  ]);
  const pieces = interleaveThinking(segs, [{ index: 0 }]);
  assert.deepEqual(
    pieces.map((p) => (p.kind === "thinking" ? `think:${p.segment.reasoning}` : `steps:${p.steps.length}`)),
    ["think:Let me look.", "steps:1", "think:Found it."],
  );
  assert.deepEqual(
    segs.map((s) => (s.endedAt ?? 0) - (s.startedAt ?? 0)),
    [3000, 3000],
  );
});

test("consecutive deltas merge into the open segment", () => {
  let segs: ThinkingSegment[] = [];
  segs = appendReasoning(segs, "a", 10, 0);
  segs = appendReasoning(segs, "b", 20, 0);
  segs = appendReasoning(segs, "c", 30, 0);
  assert.deepEqual(segs, [{ reasoning: "abc", startedAt: 10, endedAt: null, toolsBefore: 0 }]);
});

test("closing an empty placeholder drops it, and closing twice keeps the first end", () => {
  assert.deepEqual(closeThinking(startThinking([], 0, 0), 5), []);
  const once = closeThinking(appendReasoning([], "x", 1, 0), 5);
  assert.equal(closeThinking(once, 9), once);
  assert.equal(once[0]?.endedAt, 5);
});

test("a taken-back reply reopens the segment only when no tool ran since", () => {
  const closed = closeThinking(appendReasoning([], "x", 1, 0), 5);
  assert.equal(reopenThinking(closed, 0)[0]?.endedAt, null);
  assert.equal(reopenThinking(closed, 1), closed);
});

test("steps between two segments stay one burst", () => {
  const segs = [{ toolsBefore: 0 }, { toolsBefore: 2 }, { toolsBefore: 3 }];
  const pieces = interleaveThinking(segs, [{ index: 0 }, { index: 1 }, { index: 2 }, { index: 3 }]);
  assert.deepEqual(
    pieces.map((p) => (p.kind === "thinking" ? `t${p.segment.toolsBefore}` : p.steps.map((s) => s.index).join(""))),
    ["t0", "01", "t2", "2", "t3", "3"],
  );
});

test("a segment anchored to a hidden step still lands before the next shown one", () => {
  const pieces = interleaveThinking([{ toolsBefore: 1 }], [{ index: 0 }, { index: 2 }]);
  assert.deepEqual(
    pieces.map((p) => (p.kind === "thinking" ? "t" : p.steps.map((s) => s.index).join(""))),
    ["0", "t", "2"],
  );
});

test("reasoning that lands in one burst after a tool is timed from the tool's end", () => {
  let segs: readonly ThinkingSegment[] = closeThinking(appendReasoning([], "plan", 0, 0), 1000);
  const tools = [{ startedAt: 1000, endedAt: 1500 }];
  const since = lastEventAt(segs, tools);
  assert.equal(since, 1500);
  segs = appendReasoning(segs, "whole thought at once", 4000, 1, since);
  segs = closeThinking(segs, 4000);
  assert.equal(segs[1]?.startedAt, 1500);
  assert.equal(thoughtSeconds(segs[1]?.startedAt ?? null, segs[1]?.endedAt ?? 0), 2.5);
});

test("an open placeholder still starts at the first token", () => {
  const segs = appendReasoning(startThinking([], 0, 0), "a", 700, 0, 0);
  assert.equal(segs[0]?.startedAt, 700);
});

test("lastEventAt takes a running tool's start and is null for a fresh turn", () => {
  assert.equal(lastEventAt([], []), null);
  assert.equal(lastEventAt([], [{ startedAt: 300, endedAt: null }]), 300);
});

test("a segment with no measurable time has no seconds to show", () => {
  assert.equal(thoughtSeconds(1000, 1000), null);
  assert.equal(thoughtSeconds(1000, 1040), null);
  assert.equal(thoughtSeconds(null, 1000), null);
  assert.equal(thoughtSeconds(1000, 1060), 0.1);
});
