import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ProgressEvent } from "@/shared/types/api";

import { extractMinibatch, scopeToLatestLane } from "./extract-events.ts";

function event(name: string, metrics: Record<string, unknown> = {}): ProgressEvent {
  return { timestamp: "2026-01-01T00:00:00Z", event: name, metrics };
}

describe("scopeToLatestLane", () => {
  it("passes DSPy-style events without lane indices through untouched", () => {
    const events = [
      event("candidate", { candidate_id: "0" }),
      event("candidate_rejected", { rejection_id: "r1" }),
      event("optimizer_progress", {}),
    ];
    assert.equal(scopeToLatestLane(events), events);
  });

  it("keeps only the newest lane's tree events", () => {
    const events = [
      event("candidate", { candidate_id: "0", lane_index: 0 }),
      event("candidate", { candidate_id: "0", lane_index: 1 }),
      event("candidate", { candidate_id: "1", lane_index: 1 }),
      event("candidate_rejected", { rejection_id: "r1", lane_index: 0 }),
      event("minibatch_feedback", { lane_index: 1 }),
    ];
    const scoped = scopeToLatestLane(events);
    assert.deepEqual(
      scoped.map((e) => [e.event, e.metrics.lane_index ?? null]),
      [
        ["candidate", 1],
        ["candidate", 1],
        ["candidate_rejected", null],
        ["minibatch_feedback", 1],
      ].filter(([, lane]) => lane === 1),
    );
    assert.equal(scoped.length, 3);
  });

  it("keeps non-tree events from every lane", () => {
    const events = [
      event("candidate", { candidate_id: "0", lane_index: 0 }),
      event("lane_completed", { lane_index: 0 }),
      event("candidate", { candidate_id: "0", lane_index: 3 }),
      event("optimizer_progress", {}),
    ];
    const scoped = scopeToLatestLane(events);
    assert.deepEqual(
      scoped.map((e) => e.event),
      ["lane_completed", "candidate", "optimizer_progress"],
    );
  });

  it("treats missing or invalid lane indices as the first lane", () => {
    const events = [
      event("candidate", { candidate_id: "0" }),
      event("candidate", { candidate_id: "0", lane_index: "2" }),
      event("candidate", { candidate_id: "1", lane_index: 1 }),
    ];
    const scoped = scopeToLatestLane(events);
    assert.deepEqual(
      scoped.map((e) => e.metrics.candidate_id),
      ["1"],
    );
  });
});

describe("extractMinibatch", () => {
  const PNG = "data:image/png;base64,iVBORw0KGgo=";

  it("keeps the renders a scorer attached next to its note", () => {
    const [entry] = extractMinibatch([
      event("minibatch_feedback", {
        example_id: "0",
        score: 0.5,
        feedback: "close",
        images: [
          { key: "render_1", src: PNG },
          { key: "bad" },
          { key: "x", src: "http://a/b.png" },
        ],
        images_dropped: 2,
      }),
    ]);
    assert.deepEqual(entry?.images, [{ key: "render_1", src: PNG }]);
    assert.equal(entry?.images_dropped, 2);
  });

  it("reads DSPy events, which carry no renders, as having none", () => {
    const [entry] = extractMinibatch([
      event("minibatch_feedback", { example_id: "0", score: 1, feedback: "ok" }),
    ]);
    assert.deepEqual(entry?.images, []);
    assert.equal(entry?.images_dropped, 0);
  });
});
