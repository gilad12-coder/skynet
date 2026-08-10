"use client";

import { useMemo } from "react";
import { msg } from "@/shared/lib/messages";
import { displayCandidateId } from "../../lib/types";
import { computeLaneGeometry } from "./lane-geometry";
import {
  nodeA11yLabel,
  PreviewFrame,
  PREVIEW_MONO,
  type PreviewProps,
} from "./preview-shared";

const INK = "#1C1612";
const SPINE_STROKE = "#3D2E22";
const LANE_COLORS = ["#7C6350", "#7C8B5A", "#B26B4A", "#8C7A6B"];
const CHIP_FILL = "#FDFAF4";
const CHIP_BORDER = "#DDD4C8";
const WINNER_GOLD = "#9C7A3F";
const WINNER_FILL = "#F8EBC8";
const MUTED = "#8C7A6B";
const PASS_DELTA = "#7C8B5A";
const FAIL_DELTA = "#B26B4A";
const GHOST_MARK = "#C2B49F";
const LABEL_HALO = "rgba(250, 248, 245, 0.9)";
const LANE_GAP = 56;
const X_STEP = 112;
const DOT_R = 4.5;
const CHIP_H = 18;
const CHIP_GAP = 7;
const CHAR_W = 6.1;

function laneColor(lane: number): string {
  if (lane === 0) return SPINE_STROKE;
  return LANE_COLORS[(Math.abs(lane) - 1) % LANE_COLORS.length] ?? MUTED;
}

// Branch-out rails leave the parent immediately and then run flat along the
// child's lane — the classic git-graph shape where a branch owns its lane for
// its whole life. Merges are the mirror: flat along the source lane, bending
// in only just before the merge commit.
function branchOutPath(fx: number, fy: number, tx: number, ty: number): string {
  if (fy === ty) return `M ${fx} ${fy} L ${tx} ${ty}`;
  const span = Math.min(44, Math.max(20, (tx - fx) * 0.5));
  const mid = fx + span / 2;
  return `M ${fx} ${fy} C ${mid} ${fy}, ${mid} ${ty}, ${fx + span} ${ty} L ${tx} ${ty}`;
}

function mergeInPath(fx: number, fy: number, tx: number, ty: number): string {
  if (fy === ty) return `M ${fx} ${fy} L ${tx} ${ty}`;
  const span = Math.min(44, Math.max(20, (tx - fx) * 0.5));
  const mid = tx - span / 2;
  return `M ${fx} ${fy} L ${tx - span} ${fy} C ${mid} ${fy}, ${mid} ${ty}, ${tx} ${ty}`;
}

export function GitGraphPreview({
  layout,
  selectedId,
  onSelectCandidate,
  onSelectRejected,
}: PreviewProps) {
  const geo = useMemo(() => computeLaneGeometry(layout, LANE_GAP, X_STEP), [layout]);
  const { nodes, ghosts, edges, winnerId } = layout;
  const scoreOf = useMemo(
    () => new Map(nodes.map((n) => [n.candidate_id, n.score] as const)),
    [nodes],
  );
  if (nodes.length === 0) return null;
  const winnerLabel = msg("trajectory.node.winning_label");

  return (
    <PreviewFrame
      width={geo.width}
      height={geo.height}
      background="var(--background)"
      label={msg("trajectory.a11y.tree_label")}
    >
      <g fill="none" strokeLinecap="round">
        {edges.map((edge, i) => {
          const from = geo.pos.get(edge.from);
          const to = geo.pos.get(edge.to);
          if (from === undefined || to === undefined) return null;
          const onSpine = !edge.isMerge && from.lane === 0 && to.lane === 0;
          const color = edge.isMerge ? laneColor(from.lane) : laneColor(to.lane);
          return (
            <path
              key={`${edge.from}-${edge.to}-${i}`}
              d={
                edge.isMerge
                  ? mergeInPath(from.x, from.y, to.x, to.y)
                  : branchOutPath(from.x, from.y, to.x, to.y)
              }
              stroke={color}
              strokeWidth={edge.isMerge ? 1.3 : onSpine ? 2.4 : 1.6}
              strokeDasharray={edge.isMerge ? "4 4" : undefined}
              opacity={edge.isMerge ? 0.7 : onSpine ? 1 : 0.85}
            />
          );
        })}
      </g>

      <g>
        {ghosts.map((ghost) => {
          const parent = geo.pos.get(ghost.parent_id);
          const p = geo.ghostPos.get(ghost.rejection_id);
          if (parent === undefined || p === undefined) return null;
          const text = ghost.proposal_score.toFixed(2);
          const w = text.length * CHAR_W + 14;
          return (
            <g
              key={ghost.rejection_id}
              onClick={() => onSelectRejected(ghost.rejection_id)}
              style={{ cursor: "pointer" }}
            >
              <title>{msg("trajectory.ghost.legend")}</title>
              <path
                d={branchOutPath(parent.x, parent.y, p.x, p.y)}
                stroke={GHOST_MARK}
                strokeWidth={1.1}
                strokeDasharray="3 4"
                fill="none"
              />
              <rect
                x={p.x - 8}
                y={p.y - 9}
                width={w + 16}
                height={18}
                fill="transparent"
              />
              <path
                d={`M ${p.x - 3.5} ${p.y - 3.5} l 7 7 m 0 -7 l -7 7`}
                stroke={GHOST_MARK}
                strokeWidth={1.4}
                fill="none"
              />
              <text
                x={p.x + 8}
                y={p.y + 3.5}
                textAnchor="start"
                fontFamily={PREVIEW_MONO}
                fontSize="9.5"
                fill={GHOST_MARK}
                textDecoration="line-through"
                stroke={LABEL_HALO}
                strokeWidth={2.5}
                strokeLinejoin="round"
                pointerEvents="none"
                style={{ paintOrder: "stroke" }}
              >
                {text}
              </text>
            </g>
          );
        })}
      </g>

      <g>
        {nodes.map((node) => {
          const p = geo.pos.get(node.candidate_id);
          if (p === undefined) return null;
          const isWinner = node.candidate_id === winnerId;
          const isSelected = node.candidate_id === selectedId;
          const color = laneColor(p.lane);

          const idText = displayCandidateId(node.candidate_id);
          const scoreText = node.score.toFixed(2);
          const parentScore =
            node.parent_id !== null ? scoreOf.get(node.parent_id) : undefined;
          const delta = parentScore !== undefined ? node.score - parentScore : null;
          const deltaText =
            delta !== null && Math.abs(delta) >= 0.005
              ? `${delta >= 0 ? "+" : "-"}${Math.abs(delta).toFixed(2)}`
              : null;
          const fullText = `${idText} ${scoreText}${deltaText !== null ? ` ${deltaText}` : ""}`;
          const w = fullText.length * CHAR_W + 16;

          // Chips hang away from the spine so rails stay unobstructed:
          // above the dot for the spine and upper lanes, below for lower ones.
          const chipAbove = p.lane >= 0;
          const chipY = chipAbove
            ? p.y - DOT_R - CHIP_GAP - CHIP_H
            : p.y + DOT_R + CHIP_GAP;
          return (
            <g
              key={node.candidate_id}
              role="treeitem"
              aria-label={nodeA11yLabel(node)}
              aria-selected={isSelected}
              onClick={() => onSelectCandidate(node.candidate_id)}
              style={{ cursor: "pointer" }}
            >
              <title>{nodeA11yLabel(node)}</title>
              {isSelected ? (
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={isWinner ? 10.5 : 9}
                  fill="none"
                  stroke={INK}
                  strokeWidth={1.2}
                />
              ) : null}
              {isWinner ? (
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={9.5}
                  fill="none"
                  stroke={WINNER_GOLD}
                  strokeWidth={1.1}
                  strokeDasharray="2.5 3"
                />
              ) : null}
              <circle
                cx={p.x}
                cy={p.y}
                r={isWinner ? 6 : DOT_R}
                fill={isWinner ? WINNER_GOLD : p.lane === 0 ? SPINE_STROKE : CHIP_FILL}
                stroke={isWinner || p.lane === 0 ? "none" : color}
                strokeWidth={isWinner || p.lane === 0 ? 0 : 1.6}
              />
              <rect
                x={p.x - w / 2}
                y={chipY}
                width={w}
                height={CHIP_H}
                rx={5}
                fill={isWinner ? WINNER_FILL : CHIP_FILL}
                stroke={isWinner ? WINNER_GOLD : CHIP_BORDER}
                strokeWidth={isWinner ? 1.4 : 1}
              />
              <text
                x={p.x - w / 2 + 8}
                y={chipY + 12.5}
                textAnchor="start"
                fontFamily={PREVIEW_MONO}
                fontSize="9.5"
                pointerEvents="none"
              >
                <tspan fontWeight={700} fill={isWinner ? "#5E4222" : INK}>
                  {idText}
                </tspan>
                <tspan fill={MUTED}>{` ${scoreText}`}</tspan>
                {deltaText !== null ? (
                  <tspan
                    fontWeight={600}
                    fill={delta !== null && delta >= 0 ? PASS_DELTA : FAIL_DELTA}
                  >
                    {` ${deltaText}`}
                  </tspan>
                ) : null}
              </text>
              {isWinner ? (
                <text
                  x={p.x}
                  y={chipAbove ? chipY - 6 : chipY + CHIP_H + 12}
                  textAnchor="middle"
                  fontFamily={PREVIEW_MONO}
                  fontSize="9"
                  fontWeight={700}
                  letterSpacing="0.5"
                  fill={WINNER_GOLD}
                  pointerEvents="none"
                >
                  {winnerLabel}
                </text>
              ) : null}
            </g>
          );
        })}
      </g>
    </PreviewFrame>
  );
}
