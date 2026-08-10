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
const SPINE_GOLD = "#9C7A3F";
const MERGE_STROKE = "#A89579";
const STATION_FILL = "#FDFAF4";
const WINNER_FILL = "#F8EBC8";
const MUTED = "#8C7A6B";
const GHOST_MARK = "#C2B49F";
const LABEL_HALO = "rgba(250, 248, 245, 0.9)";
const LINE_COLORS = ["#7C6350", "#7C8B5A", "#B26B4A", "#8C7A6B"];
const LANE_GAP = 64;
const X_STEP = 108;

function lineColor(lane: number): string {
  if (lane === 0) return SPINE_GOLD;
  return LINE_COLORS[(Math.abs(lane) - 1) % LINE_COLORS.length] ?? MERGE_STROKE;
}

// Transit-style elbow: run along the parent's lane, then one smooth bend into
// the child's lane just before its station.
function railPath(fx: number, fy: number, tx: number, ty: number): string {
  if (fy === ty) return `M ${fx} ${fy} L ${tx} ${ty}`;
  const bend = Math.min(46, Math.max(18, (tx - fx) * 0.55));
  const elbowX = Math.max(fx + 4, tx - bend);
  return `M ${fx} ${fy} L ${elbowX - bend * 0.4} ${fy} C ${elbowX + bend * 0.4} ${fy}, ${tx - bend * 0.2} ${ty}, ${tx} ${ty}`;
}

export function TransitPreview({
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
              d={railPath(from.x, from.y, to.x, to.y)}
              stroke={edge.isMerge ? MERGE_STROKE : onSpine ? SPINE_GOLD : lineColor(to.lane)}
              strokeWidth={edge.isMerge ? 1.4 : onSpine ? 5 : 3.2}
              strokeDasharray={edge.isMerge ? "4 5" : undefined}
              strokeLinecap="round"
              opacity={edge.isMerge ? 0.75 : onSpine ? 1 : 0.85}
            />
          );
        })}
      </g>

      <g>
        {ghosts.map((ghost) => {
          const parent = geo.pos.get(ghost.parent_id);
          const p = geo.ghostPos.get(ghost.rejection_id);
          if (parent === undefined || p === undefined) return null;
          return (
            <g
              key={ghost.rejection_id}
              onClick={() => onSelectRejected(ghost.rejection_id)}
              style={{ cursor: "pointer" }}
            >
              <title>{msg("trajectory.ghost.legend")}</title>
              <path
                d={`M ${parent.x} ${parent.y} L ${p.x} ${p.y}`}
                stroke={GHOST_MARK}
                strokeWidth={1.3}
                strokeDasharray="3 4"
                fill="none"
              />
              <circle cx={p.x} cy={p.y} r={4} fill={STATION_FILL} stroke={GHOST_MARK} strokeWidth={1.4} />
              <line
                x1={p.x - 3}
                y1={p.y + 3}
                x2={p.x + 3}
                y2={p.y - 3}
                stroke={GHOST_MARK}
                strokeWidth={1.4}
              />
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
          const onSpine = node.isOnSpine;
          const r = isWinner ? 9 : onSpine ? 7 : 5.5;
          const ring = isWinner ? SPINE_GOLD : lineColor(p.lane);
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
                <circle cx={p.x} cy={p.y} r={r + 6} fill="none" stroke={INK} strokeWidth={1.2} />
              ) : null}
              {isWinner ? (
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={r + 4}
                  fill="none"
                  stroke={SPINE_GOLD}
                  strokeWidth={1.2}
                />
              ) : null}
              <circle
                cx={p.x}
                cy={p.y}
                r={r}
                fill={isWinner ? WINNER_FILL : STATION_FILL}
                stroke={ring}
                strokeWidth={isWinner ? 2.6 : onSpine ? 2.6 : 2.2}
              />
              <text
                x={p.x}
                y={p.y - r - 8}
                textAnchor="middle"
                fontFamily="var(--font-ui, system-ui)"
                fontSize="10.5"
                fontWeight={700}
                fill={isWinner ? "#5E4222" : INK}
                stroke={LABEL_HALO}
                strokeWidth={2.5}
                strokeLinejoin="round"
                pointerEvents="none"
                style={{ paintOrder: "stroke" }}
              >
                {displayCandidateId(node.candidate_id)}
              </text>
              <text
                x={p.x}
                y={p.y + r + 15}
                textAnchor="middle"
                fontFamily={PREVIEW_MONO}
                fontSize="9.5"
                fill={MUTED}
                stroke={LABEL_HALO}
                strokeWidth={2.5}
                strokeLinejoin="round"
                pointerEvents="none"
                style={{ paintOrder: "stroke" }}
              >
                {node.score.toFixed(2)}
              </text>
              {isWinner ? (
                <g pointerEvents="none">
                  <rect
                    x={p.x - (winnerLabel.length * 3.4 + 10)}
                    y={p.y + r + 21}
                    width={winnerLabel.length * 6.8 + 20}
                    height={16}
                    rx={8}
                    fill={SPINE_GOLD}
                  />
                  <text
                    x={p.x}
                    y={p.y + r + 32.5}
                    textAnchor="middle"
                    fontFamily="var(--font-ui, system-ui)"
                    fontSize="9.5"
                    fontWeight={700}
                    letterSpacing="0.4"
                    fill="#FBF4DF"
                  >
                    {winnerLabel}
                  </text>
                </g>
              ) : null}
            </g>
          );
        })}
      </g>
    </PreviewFrame>
  );
}
