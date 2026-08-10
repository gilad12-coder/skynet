"use client";

import { useMemo } from "react";
import { msg } from "@/shared/lib/messages";
import { TRAJECTORY_LAYOUT } from "../../lib/layout";
import { displayCandidateId } from "../../lib/types";
import {
  nodeA11yLabel,
  PreviewFrame,
  PREVIEW_SERIF,
  type PreviewProps,
} from "./preview-shared";

const PAPER = "#FBF7EF";
const RULE_STROKE = "#EFE7D9";
const INK = "#3A2C1E";
const SPINE_BRANCH = "#5E4634";
const SIDE_BRANCH = "#8B7360";
const MERGE_BRANCH = "#A89579";
const SPRIG = "#A89579";
const SPRIG_FILL = "#F1E7D2";
const NODE_FILL = "#F7EFE0";
const WINNER_FILL = "#F8EBC8";
const GOLD = "#9C7A3F";
const ANNOTATION = "#8C7A6B";
const NODE_R = 13;

// A gentle S-sway between parent and child so branches read as grown rather
// than plotted; tangents stay near-vertical to keep descent legible.
function branchPath(x1: number, y1: number, x2: number, y2: number): string {
  const sway = (x2 - x1) * 0.08;
  const dy = y2 - y1;
  return `M ${x1} ${y1} C ${x1 + sway} ${y1 + dy * 0.5}, ${x2 - sway} ${y2 - dy * 0.5}, ${x2} ${y2}`;
}

export function NotebookPreview({
  layout,
  selectedId,
  onSelectCandidate,
  onSelectRejected,
}: PreviewProps) {
  const { nodes, ghosts, edges, width, height, winnerId, spineIds } = layout;
  const idIndex = useMemo(() => {
    const m = new Map(nodes.map((n) => [n.candidate_id, n] as const));
    return m;
  }, [nodes]);
  const rowYs = useMemo(
    () => Array.from(new Set(nodes.map((n) => n.y))).sort((a, b) => a - b),
    [nodes],
  );
  if (nodes.length === 0) return null;
  const pad = 40;

  return (
    <PreviewFrame
      width={width + pad * 2}
      height={height + pad * 2}
      background={PAPER}
      label={msg("trajectory.a11y.tree_label")}
    >
      <g transform={`translate(${pad}, ${pad})`}>
        {rowYs.slice(0, -1).map((y) => (
          <line
            key={`rule-${y}`}
            x1={-pad}
            y1={y + TRAJECTORY_LAYOUT.gapY / 2}
            x2={width + pad}
            y2={y + TRAJECTORY_LAYOUT.gapY / 2}
            stroke={RULE_STROKE}
            strokeWidth={1}
          />
        ))}

        <g fill="none" strokeLinecap="round">
          {edges.map((edge, i) => {
            const from = idIndex.get(edge.from);
            const to = idIndex.get(edge.to);
            if (from === undefined || to === undefined) return null;
            const onSpine =
              !edge.isMerge && spineIds.has(edge.from) && spineIds.has(edge.to);
            const d = branchPath(from.x, from.y, to.x, to.y);
            return (
              <g key={`${edge.from}-${edge.to}-${i}`}>
                {onSpine ? (
                  <path d={d} stroke={SPINE_BRANCH} strokeWidth={4.6} opacity={0.22} />
                ) : null}
                <path
                  d={d}
                  stroke={edge.isMerge ? MERGE_BRANCH : onSpine ? SPINE_BRANCH : SIDE_BRANCH}
                  strokeWidth={edge.isMerge ? 1.3 : onSpine ? 3 : 1.7}
                  strokeDasharray={edge.isMerge ? "5 5" : undefined}
                  opacity={edge.isMerge ? 0.8 : onSpine ? 1 : 0.75}
                />
              </g>
            );
          })}
        </g>

        <g>
          {ghosts.map((ghost) => {
            const parent = idIndex.get(ghost.parent_id);
            if (parent === undefined) return null;
            const mx = (parent.x + ghost.x) / 2;
            const my = (parent.y + ghost.y) / 2;
            const nx = -(ghost.y - parent.y) * 0.18;
            const ny = (ghost.x - parent.x) * 0.18;
            return (
              <g
                key={ghost.rejection_id}
                onClick={() => onSelectRejected(ghost.rejection_id)}
                style={{ cursor: "pointer" }}
              >
                <title>{msg("trajectory.ghost.legend")}</title>
                <path
                  d={`M ${parent.x} ${parent.y} Q ${mx + nx} ${my + ny} ${ghost.x} ${ghost.y}`}
                  fill="none"
                  stroke={SPRIG}
                  strokeWidth={1.1}
                  opacity={0.7}
                />
                <circle
                  cx={ghost.x}
                  cy={ghost.y}
                  r={4.2}
                  fill={SPRIG_FILL}
                  stroke={SPRIG}
                  strokeWidth={1.1}
                  opacity={0.85}
                />
              </g>
            );
          })}
        </g>

        <g>
          {nodes.map((node) => {
            const isWinner = node.candidate_id === winnerId;
            const isSelected = node.candidate_id === selectedId;
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
                    cx={node.x}
                    cy={node.y}
                    r={NODE_R + 5}
                    fill="none"
                    stroke="#1c1612"
                    strokeWidth={1.3}
                  />
                ) : null}
                {isWinner ? (
                  <circle
                    cx={node.x}
                    cy={node.y}
                    r={NODE_R + 5.5}
                    fill="none"
                    stroke={GOLD}
                    strokeWidth={1.1}
                    strokeDasharray="2.5 3"
                  />
                ) : null}
                <circle
                  cx={node.x}
                  cy={node.y}
                  r={isWinner ? NODE_R + 0.5 : NODE_R}
                  fill={isWinner ? WINNER_FILL : NODE_FILL}
                  stroke={isWinner ? GOLD : INK}
                  strokeWidth={isWinner ? 2.2 : node.isOnSpine ? 1.6 : 1.2}
                  opacity={node.isOnSpine || isWinner ? 1 : 0.88}
                />
                <text
                  x={node.x}
                  y={node.y + 4.5}
                  textAnchor="middle"
                  fontFamily={PREVIEW_SERIF}
                  fontSize="12.5"
                  fontWeight={700}
                  fill={isWinner ? "#5E4222" : INK}
                  pointerEvents="none"
                >
                  {displayCandidateId(node.candidate_id)}
                </text>
                <text
                  x={node.x + NODE_R + 6}
                  y={node.y - NODE_R + 4}
                  textAnchor="start"
                  fontFamily={PREVIEW_SERIF}
                  fontStyle="italic"
                  fontSize="11"
                  fill={isWinner ? GOLD : ANNOTATION}
                  pointerEvents="none"
                >
                  {node.score.toFixed(2)}
                </text>
                {isWinner ? (
                  <text
                    x={node.x}
                    y={node.y + NODE_R + 18}
                    textAnchor="middle"
                    fontFamily={PREVIEW_SERIF}
                    fontStyle="italic"
                    fontSize="11"
                    fontWeight={600}
                    fill={GOLD}
                    pointerEvents="none"
                  >
                    {msg("trajectory.node.winning_label")}
                  </text>
                ) : null}
              </g>
            );
          })}
        </g>
      </g>
    </PreviewFrame>
  );
}
