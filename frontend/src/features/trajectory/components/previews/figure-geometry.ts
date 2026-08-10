// Shared geometry for the two score-axis previews (scientific figure and the
// field-figure hybrid): x = discovery order, y = validation score.

import type { LayoutResult } from "../../lib/layout";

export interface FigureGeometry {
  width: number;
  height: number;
  plot: { left: number; right: number; top: number; bottom: number };
  pos: Map<string, { x: number; y: number }>;
  ghostPos: Map<string, { x: number; y: number }>;
  ticks: number[];
  yOf: (score: number) => number;
  seedScore: number | null;
  bestScore: number;
}

const WIDTH = 960;
const HEIGHT = 520;
const TICK_STEPS = [0.005, 0.01, 0.02, 0.025, 0.05, 0.1, 0.2, 0.25, 0.5];

export function computeFigureGeometry(layout: LayoutResult): FigureGeometry {
  const { nodes, ghosts } = layout;
  const plot = { left: 84, right: WIDTH - 96, top: 52, bottom: HEIGHT - 68 };

  const scores: number[] = nodes.map((n) => n.score);
  for (const g of ghosts) scores.push(g.proposal_score);
  const lo = scores.length > 0 ? Math.min(...scores) : 0;
  const hi = scores.length > 0 ? Math.max(...scores) : 1;
  const pad = Math.max(0.015, (hi - lo) * 0.12);
  const domainLo = lo - pad;
  const domainHi = hi + pad;
  const yOf = (score: number): number =>
    plot.bottom - ((score - domainLo) / (domainHi - domainLo)) * (plot.bottom - plot.top);

  const range = domainHi - domainLo;
  let step = TICK_STEPS[TICK_STEPS.length - 1] ?? 0.1;
  for (const s of TICK_STEPS) {
    if (range / s <= 6) {
      step = s;
      break;
    }
  }
  const ticks: number[] = [];
  for (let t = Math.ceil(domainLo / step) * step; t <= domainHi + 1e-9; t += step) {
    ticks.push(Number(t.toFixed(4)));
  }

  const xStep = nodes.length > 1 ? (plot.right - plot.left) / (nodes.length - 1) : 0;
  const pos = new Map<string, { x: number; y: number }>();
  nodes.forEach((node, i) => {
    const x = nodes.length > 1 ? plot.left + i * xStep : (plot.left + plot.right) / 2;
    pos.set(node.candidate_id, { x, y: yOf(node.score) });
  });

  // Rejected proposals sit a fraction of a column after their parent, staggered
  // so several rejections off one parent don't stack on the same x.
  const ghostPos = new Map<string, { x: number; y: number }>();
  const perParent = new Map<string, number>();
  for (const ghost of ghosts) {
    const parent = pos.get(ghost.parent_id);
    if (parent === undefined) continue;
    const idx = perParent.get(ghost.parent_id) ?? 0;
    perParent.set(ghost.parent_id, idx + 1);
    const spread = xStep > 0 ? xStep : 60;
    const x = Math.min(plot.right, parent.x + spread * (0.32 + (idx % 3) * 0.14));
    ghostPos.set(ghost.rejection_id, { x, y: yOf(ghost.proposal_score) });
  }

  const seed = nodes.find((n) => n.parent_id === null) ?? nodes[0];
  return {
    width: WIDTH,
    height: HEIGHT,
    plot,
    pos,
    ghostPos,
    ticks,
    yOf,
    seedScore: seed !== undefined ? seed.score : null,
    bestScore: hi,
  };
}
