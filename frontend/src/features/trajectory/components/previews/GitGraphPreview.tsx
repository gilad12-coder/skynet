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
const BRANCH_STROKE = "#A89579";
const CHIP_FILL = "#FDFAF4";
const CHIP_BORDER = "#DDD4C8";
const WINNER_GOLD = "#9C7A3F";
const WINNER_FILL = "#F8EBC8";
const MUTED = "#8C7A6B";
const GHOST_MARK = "#C2B49F";
const LANE_GAP = 46;
const X_STEP = 96;
const DOT_R = 4.5;
const CHIP_H = 17;
const CHAR_W = 6.1;

function chipWidth(text: string): number {
  return text.length * CHAR_W + 14;
}

// Git-graph elbow: hold the parent's lane, then a short quarter-bend into the
// child's lane right before its commit.
function graphPath(fx: number, fy: number, tx: number, ty: number): string {
  if (fy === ty) return `M ${fx} ${fy} L ${tx} ${ty}`;
  const bend = Math.min(28, Math.max(12, (tx - fx) * 0.4));
  const elbowX = Math.max(fx + 2, tx - bend);
  return `M ${fx} ${fy} L ${elbowX - bend * 0.3} ${fy} C ${elbowX + bend * 0.35} ${fy}, ${tx - bend * 0.15} ${ty}, ${tx} ${ty}`;
}

export function GitGraphPreview({
  layout,
  selectedId,
  onSelectCandidate,
  onSelectRejected,
}: PreviewProps) {
  const geo = useMemo(() => computeLaneGeometry(layout, LANE_GAP, X_STEP), [layout]);
  const { nodes, ghosts, edges, winnerId, spineIds } = layout;
  if (nodes.length === 0) return null;
  const winnerLabel = msg("trajectory.node.winning_label");

  return (
    <PreviewFrame
      width={geo.width}
      height={geo.height}
      background="var(--background)"
      label={msg("trajectory.a11y.tree_label")}
    >
      <g fill="none">
        {edges.map((edge, i) => {
          const from = geo.pos.get(edge.from);
          const to = geo.pos.get(edge.to);
          if (from === undefined || to === undefined) return null;
          const onSpine = !edge.isMerge && spineIds.has(edge.from) && spineIds.has(edge.to);
          return (
            <path
              key={`${edge.from}-${edge.to}-${i}`}
              d={graphPath(from.x, from.y, to.x, to.y)}
              stroke={onSpine ? SPINE_STROKE : BRANCH_STROKE}
              strokeWidth={edge.isMerge ? 1.2 : onSpine ? 2 : 1.4}
              strokeDasharray={edge.isMerge ? "3 4" : undefined}
              strokeLinecap="round"
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
          const w = chipWidth(text);
          return (
            <g
              key={ghost.rejection_id}
              onClick={() => onSelectRejected(ghost.rejection_id)}
              style={{ cursor: "pointer" }}
            >
              <title>{msg("trajectory.ghost.legend")}</title>
              <path
                d={`M ${parent.x} ${parent.y} L ${p.x} ${p.y - CHIP_H / 2}`}
                stroke={GHOST_MARK}
                strokeWidth={1.1}
                strokeDasharray="3 4"
                fill="none"
              />
              <rect
                x={p.x - w / 2}
                y={p.y - CHIP_H / 2}
                width={w}
                height={CHIP_H}
                rx={4}
                fill="var(--background)"
                stroke={GHOST_MARK}
                strokeWidth={1}
                strokeDasharray="3 3"
              />
              <text
                x={p.x}
                y={p.y + 3.5}
                textAnchor="middle"
                fontFamily={PREVIEW_MONO}
                fontSize="9.5"
                fill={GHOST_MARK}
                textDecoration="line-through"
                pointerEvents="none"
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
          const chipText = `${displayCandidateId(node.candidate_id)} ${node.score.toFixed(2)}`;
          const w = chipWidth(chipText);
          const chipY = p.y - LANE_GAP / 2 - CHIP_H + 6;
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
                <circle cx={p.x} cy={p.y} r={DOT_R + 5} fill="none" stroke={INK} strokeWidth={1.2} />
              ) : null}
              <circle
                cx={p.x}
                cy={p.y}
                r={isWinner ? DOT_R + 1.5 : DOT_R}
                fill={isWinner ? WINNER_GOLD : node.isOnSpine ? SPINE_STROKE : CHIP_FILL}
                stroke={node.isOnSpine || isWinner ? "none" : "#7C6350"}
                strokeWidth={node.isOnSpine || isWinner ? 0 : 1.4}
              />
              <line
                x1={p.x}
                y1={chipY + CHIP_H}
                x2={p.x}
                y2={p.y - (isWinner ? DOT_R + 1.5 : DOT_R)}
                stroke={CHIP_BORDER}
                strokeWidth={1}
              />
              <rect
                x={p.x - w / 2}
                y={chipY}
                width={w}
                height={CHIP_H}
                rx={4}
                fill={isWinner ? WINNER_FILL : CHIP_FILL}
                stroke={isWinner ? WINNER_GOLD : CHIP_BORDER}
                strokeWidth={isWinner ? 1.4 : 1}
              />
              <text
                x={p.x}
                y={chipY + 12}
                textAnchor="middle"
                fontFamily={PREVIEW_MONO}
                fontSize="9.5"
                fontWeight={isWinner ? 700 : node.isOnSpine ? 600 : 400}
                fill={isWinner ? "#5E4222" : node.isOnSpine ? INK : MUTED}
                pointerEvents="none"
              >
                {chipText}
              </text>
              {isWinner ? (
                <text
                  x={p.x}
                  y={chipY - 6}
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
