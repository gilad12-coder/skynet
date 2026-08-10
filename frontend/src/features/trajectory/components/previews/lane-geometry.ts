// Shared lane layout for the two rail-style previews (transit map and git
// graph): x = discovery order, y = lane. The winning spine holds lane 0; each
// side branch claims its own lane, alternating above/below the spine.

import type { LayoutResult } from "../../lib/layout";

export interface LaneGeometry {
  width: number;
  height: number;
  pos: Map<string, { x: number; y: number; lane: number }>;
  ghostPos: Map<string, { x: number; y: number }>;
  spineY: number;
}

export function computeLaneGeometry(
  layout: LayoutResult,
  laneGap: number,
  xStep: number,
): LaneGeometry {
  const { nodes, ghosts, spineIds } = layout;
  const padX = 84;
  const padY = 72;

  const laneOf = new Map<string, number>();
  // A branch keeps its parent's lane until a sibling forces a fork; brand-new
  // branches take the next unused lane so unrelated branches never collide.
  const continued = new Set<string>();
  let allocCount = 0;
  const newLane = (): number => {
    allocCount += 1;
    const mag = Math.ceil(allocCount / 2);
    return allocCount % 2 === 1 ? mag : -mag;
  };
  for (const node of nodes) {
    if (spineIds.has(node.candidate_id)) {
      laneOf.set(node.candidate_id, 0);
      continue;
    }
    const parentLane =
      node.parent_id !== null ? laneOf.get(node.parent_id) : undefined;
    if (
      node.parent_id !== null &&
      parentLane !== undefined &&
      parentLane !== 0 &&
      !continued.has(node.parent_id)
    ) {
      laneOf.set(node.candidate_id, parentLane);
      continued.add(node.parent_id);
    } else {
      laneOf.set(node.candidate_id, newLane());
    }
  }

  let maxUp = 0;
  let maxDown = 0;
  for (const lane of laneOf.values()) {
    if (lane > maxUp) maxUp = lane;
    if (-lane > maxDown) maxDown = -lane;
  }
  const spineY = padY + maxUp * laneGap;
  const width = padX * 2 + Math.max(1, nodes.length - 1) * xStep;
  const height = spineY + maxDown * laneGap + padY + (ghosts.length > 0 ? 30 : 0);

  const pos = new Map<string, { x: number; y: number; lane: number }>();
  nodes.forEach((node, i) => {
    const lane = laneOf.get(node.candidate_id) ?? 0;
    pos.set(node.candidate_id, {
      x: padX + i * xStep,
      y: spineY - lane * laneGap,
      lane,
    });
  });

  const ghostPos = new Map<string, { x: number; y: number }>();
  const perParent = new Map<string, number>();
  for (const ghost of ghosts) {
    const parent = pos.get(ghost.parent_id);
    if (parent === undefined) continue;
    const idx = perParent.get(ghost.parent_id) ?? 0;
    perParent.set(ghost.parent_id, idx + 1);
    ghostPos.set(ghost.rejection_id, {
      x: parent.x + xStep * (0.3 + (idx % 3) * 0.18),
      y: parent.y + laneGap * 0.62,
    });
  }

  return { width, height, pos, ghostPos, spineY };
}
