import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { layoutTrajectory, TRAJECTORY_LAYOUT } from "./layout.ts";
import type { CandidateMetrics, RejectedMetrics } from "./types.ts";

function candidate(id: string, parent: string | null, iteration: number | null): CandidateMetrics {
  return {
    candidate_id: id,
    parent_id: parent,
    parents_extra: [],
    generation: parent === null ? 0 : 1,
    score: Number(id) / 10,
    per_example: [],
    prompt: {},
    discovered_at_evals: 0,
    iteration,
    timestamp: "",
  };
}

function rejection(id: string, parent: string, iteration: number): RejectedMetrics {
  return {
    rejection_id: id,
    iteration,
    parent_id: parent,
    parent_score: 0,
    proposal_score: 0,
    subsample_size: 0,
    proposal_prompt: {},
    parent_prompt: {},
    subsample_ids: [],
    per_example_parent: [],
    per_example_proposal: [],
  };
}

describe("layoutTrajectory", () => {
  const candidates = [candidate("0", null, null), candidate("1", "0", 1), candidate("2", "0", 3)];

  it("gives each rejected proposal its own slot one row below its parent", () => {
    const layout = layoutTrajectory(candidates, [rejection("r1", "0", 2)]);
    const [ghost] = layout.ghosts;
    const byId = new Map(layout.nodes.map((n) => [n.candidate_id, n]));
    const kept1 = byId.get("1");
    const kept2 = byId.get("2");
    assert.ok(ghost && kept1 && kept2);
    assert.equal(ghost.y, kept1.y);
    // Ordered by iteration: candidate 1, then the rejection, then candidate 2.
    assert.equal(ghost.x, kept1.x + TRAJECTORY_LAYOUT.gapX);
    assert.equal(kept2.x, ghost.x + TRAJECTORY_LAYOUT.gapX);
    assert.equal(byId.get("0")?.subtreeWidth, 3);
  });

  it("closes the gap when laid out without rejections", () => {
    const withGhost = layoutTrajectory(candidates, [rejection("r1", "0", 2)]);
    const without = layoutTrajectory(candidates);
    assert.equal(without.ghosts.length, 0);
    assert.ok(without.width < withGhost.width);
  });

  it("drops rejections whose parent is not in the tree", () => {
    const layout = layoutTrajectory(candidates, [rejection("r1", "9", 2)]);
    assert.equal(layout.ghosts.length, 0);
  });
});
