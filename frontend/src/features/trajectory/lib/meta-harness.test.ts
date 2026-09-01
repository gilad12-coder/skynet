import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ProgressEvent } from "@/shared/types/api";
import type { CandidateMetrics } from "./types";

import {
  CLIMB_LAYOUT,
  buildClimb,
  engineOfLatestLane,
  extractCaseScores,
  isMetaHarnessRun,
  latestVersionLane,
  layoutClimb,
  scopeToVersionLane,
} from "./meta-harness.ts";

function event(name: string, metrics: Record<string, unknown> = {}): ProgressEvent {
  return { timestamp: "2026-01-01T00:00:00Z", event: name, metrics };
}

function candidate(
  id: string,
  score: number,
  parent: string | null,
  perExample: Array<[string, number]> = [],
): CandidateMetrics {
  return {
    candidate_id: id,
    parent_id: parent,
    parents_extra: [],
    generation: parent === null ? 0 : 1,
    score,
    per_example: perExample.map(([caseId, caseScore]) => ({ id: caseId, score: caseScore })),
    prompt: { current_candidate: `v${id}` },
    discovered_at_evals: 0,
    iteration: Number(id),
    timestamp: "2026-01-01T00:00:00Z",
  };
}

describe("latestVersionLane", () => {
  it("counts case scores as version events", () => {
    const events = [
      event("candidate", { candidate_id: "0", lane_index: 0 }),
      event("case_scored", { trial: 0, example_id: "0", score: 1, total: 1, lane_index: 2 }),
    ];
    assert.equal(latestVersionLane(events), 2);
  });

  it("scopes version events to that lane and passes the rest through", () => {
    const events = [
      event("candidate", { candidate_id: "0", lane_index: 0 }),
      event("lane_completed", { engine: "gepa" }),
      event("case_scored", { trial: 0, example_id: "0", score: 1, total: 1, lane_index: 1 }),
      event("minibatch_feedback", { lane_index: 0 }),
    ];
    assert.deepEqual(
      scopeToVersionLane(events).map((e) => e.event),
      ["lane_completed", "case_scored"],
    );
  });
});

describe("engineOfLatestLane", () => {
  it("reads the engine from the lane_started event of the newest lane", () => {
    const events = [
      event("lane_started", { engine: "gepa", phase: "explore" }),
      event("candidate", { candidate_id: "0", lane_index: 0 }),
      event("lane_started", { engine: "meta_harness", phase: "continue" }),
      event("case_scored", { trial: 0, example_id: "0", score: 1, total: 2, lane_index: 1 }),
    ];
    assert.equal(engineOfLatestLane(events), "meta_harness");
    assert.equal(isMetaHarnessRun(events, "gepa", "gepa"), true);
  });

  it("falls back to the result's engine, then the strategy's, without lane events", () => {
    assert.equal(engineOfLatestLane([]), null);
    assert.equal(isMetaHarnessRun([], "meta_harness", null), true);
    assert.equal(isMetaHarnessRun([], null, "meta_harness"), true);
    assert.equal(isMetaHarnessRun([], "gepa", "meta_harness"), false);
    assert.equal(isMetaHarnessRun([], null, null), false);
  });
});

describe("extractCaseScores", () => {
  it("keeps well-formed case scores and coerces numeric case ids", () => {
    const events = [
      event("case_scored", { trial: 1, example_id: 3, score: 0.5, total: 4 }),
      event("case_scored", { trial: "1", example_id: "0", score: 0.5, total: 4 }),
      event("case_scored", { trial: 1, example_id: "0", score: "high", total: 4 }),
      event("candidate", { candidate_id: "0" }),
    ];
    assert.deepEqual(extractCaseScores(events), [
      { trial: 1, example_id: "3", score: 0.5, total: 4 },
    ]);
  });
});

describe("buildClimb", () => {
  it("marks the versions that beat the best before them and keeps the first best", () => {
    const model = buildClimb(
      [
        candidate("2", 0.8, "1", [["0", 1]]),
        candidate("0", 0.5, null, [["0", 0.5]]),
        candidate("1", 0.8, "0", [["1", 0.8]]),
        candidate("3", 0.4, "1", [["10", 0.4]]),
      ],
      [],
    );
    assert.deepEqual(
      model.versions.map((v) => [v.index, v.improved, v.bestBefore]),
      [
        [0, true, null],
        [1, true, 0.5],
        [2, false, 0.8],
        [3, false, 0.8],
      ],
    );
    assert.equal(model.bestId, "1");
    assert.deepEqual(model.caseIds, ["0", "1", "10"]);
    assert.equal(model.pending, null);
  });

  it("collects the cases of the version scored after the last complete one", () => {
    const model = buildClimb(
      [candidate("0", 0.5, null, [["0", 0.5]])],
      [
        { trial: 0, example_id: "0", score: 0.5, total: 2 },
        { trial: 1, example_id: "1", score: 0.9, total: 2 },
        { trial: 1, example_id: "0", score: 0.7, total: 2 },
      ],
    );
    assert.notEqual(model.pending, null);
    assert.equal(model.pending?.index, 1);
    assert.equal(model.pending?.total, 2);
    assert.deepEqual(
      [...(model.pending?.scores.entries() ?? [])],
      [
        ["1", 0.9],
        ["0", 0.7],
      ],
    );
    assert.deepEqual(model.caseIds, ["0", "1"]);
  });

  it("ignores case scores of versions that already completed", () => {
    const model = buildClimb(
      [candidate("0", 0.5, null), candidate("1", 0.6, "0")],
      [{ trial: 1, example_id: "0", score: 0.6, total: 1 }],
    );
    assert.equal(model.pending, null);
  });
});

describe("layoutClimb", () => {
  const model = buildClimb(
    [
      candidate("0", 0.2, null),
      candidate("1", 0.6, "0"),
      candidate("2", 0.4, "1"),
      candidate("3", 0.9, "1"),
    ],
    [{ trial: 4, example_id: "0", score: 0.5, total: 3 }],
  );

  it("places versions left to right at a pitch that fills the width", () => {
    const narrow = layoutClimb(model);
    assert.deepEqual(
      narrow.points.map((p) => p.x),
      [0, 1, 2, 3].map((i) => CLIMB_LAYOUT.padStart + i * CLIMB_LAYOUT.stepMin),
    );
    const wide = layoutClimb(model, { availableWidth: 10_000 });
    const pitch = (wide.points[1]?.x ?? 0) - (wide.points[0]?.x ?? 0);
    assert.equal(pitch, CLIMB_LAYOUT.stepMax);
    assert.equal(
      wide.width,
      CLIMB_LAYOUT.padStart + 3 * CLIMB_LAYOUT.stepMax + CLIMB_LAYOUT.padEnd,
    );
  });

  it("uses the unit scale when every score is a fraction and ranks higher scores higher", () => {
    const layout = layoutClimb(model);
    assert.deepEqual(layout.domain, { min: 0, max: 1, unit: true });
    const ys = layout.points.map((p) => p.y);
    assert.ok((ys[1] ?? 0) < (ys[0] ?? 0));
    assert.ok((ys[2] ?? 0) > (ys[1] ?? 0));
    assert.ok((ys[3] ?? 0) < (ys[1] ?? 0));
    assert.equal(layout.ticks.length, CLIMB_LAYOUT.tickCount);
    assert.equal(layout.ticks[0]?.value, 0);
    assert.equal(layout.ticks[CLIMB_LAYOUT.tickCount - 1]?.value, 1);
  });

  it("pads a free-form scale around the scores", () => {
    const wide = buildClimb([candidate("0", 10, null), candidate("1", 30, "0")], []);
    const layout = layoutClimb(wide);
    assert.equal(layout.domain.unit, false);
    assert.ok(layout.domain.min < 10);
    assert.ok(layout.domain.max > 30);
  });

  it("draws the best-so-far staircase that never steps down", () => {
    const layout = layoutClimb(model);
    const ys = layout.bestPath.map((p) => p.y);
    for (let i = 1; i < ys.length; i += 1) assert.ok((ys[i] ?? 0) <= (ys[i - 1] ?? 0));
    assert.equal(layout.bestPath.length, 2 * layout.points.length - 1);
    assert.equal(layout.edges.length, 3);
    assert.deepEqual(
      layout.edges.map((e) => [e.from.id, e.to.id]),
      [
        ["0", "1"],
        ["1", "2"],
        ["1", "3"],
      ],
    );
  });

  it("adds the pending version as a last column only when asked", () => {
    assert.equal(layoutClimb(model).pending, null);
    const layout = layoutClimb(model, { showPending: true });
    assert.notEqual(layout.pending, null);
    assert.equal(layout.pending?.x, CLIMB_LAYOUT.padStart + 4 * CLIMB_LAYOUT.stepMin);
    assert.equal(
      layout.width,
      CLIMB_LAYOUT.padStart + 4 * CLIMB_LAYOUT.stepMin + CLIMB_LAYOUT.padEnd,
    );
  });
});
