"use client";

import { useMemo } from "react";
import { msg } from "@/shared/lib/messages";
import { displayCandidateId } from "../../lib/types";
import { computeFigureGeometry } from "./figure-geometry";
import {
  nodeA11yLabel,
  passStats,
  PreviewFrame,
  PREVIEW_MONO,
  PREVIEW_SERIF,
  type PreviewProps,
} from "./preview-shared";

const INK = "#1C1612";
const SPINE_GOLD = "#9C7A3F";
const BRANCH_STROKE = "#A89579";
const GHOST_MARK = "#C2B49F";
const RULE_STROKE = "#EFE7D9";
const MUTED = "#8C7A6B";
const CORE_FILL = "#FDFAF4";
const WINNER_FILL = "#F8EBC8";
const PASS_ARC = "#7C8B5A";
const FAIL_TRACK = "#B26B4A";
const LABEL_HALO = "rgba(250, 248, 245, 0.9)";
const NODE_R = 8;
const ARC_R = 11.5;

// Stroke-arc for the pass share of the ring; a full circle can't be drawn as
// one SVG arc (start == end collapses the command), so f >= 1 renders as a
// plain circle at the call site.
function passArcPath(cx: number, cy: number, r: number, fraction: number): string {
  const start = -Math.PI / 2;
  const end = start + fraction * 2 * Math.PI;
  const x1 = cx + r * Math.cos(start);
  const y1 = cy + r * Math.sin(start);
  const x2 = cx + r * Math.cos(end);
  const y2 = cy + r * Math.sin(end);
  const largeArc = fraction > 0.5 ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`;
}

export function FieldFigurePreview({
  layout,
  selectedId,
  onSelectCandidate,
  onSelectRejected,
}: PreviewProps) {
  const geo = useMemo(() => computeFigureGeometry(layout), [layout]);
  const { nodes, ghosts, edges, spineIds, winnerId } = layout;
  if (nodes.length === 0) return null;
  const winnerLabel = msg("trajectory.node.winning_label");

  return (
    <PreviewFrame
      width={geo.width}
      height={geo.height}
      background="var(--background)"
      label={msg("trajectory.a11y.tree_label")}
    >
      {geo.ticks.map((t) => (
        <g key={`rule-${t}`}>
          <line
            x1={geo.plot.left - 26}
            y1={geo.yOf(t)}
            x2={geo.plot.right + 40}
            y2={geo.yOf(t)}
            stroke={RULE_STROKE}
            strokeWidth={1}
          />
          <text
            x={geo.plot.left - 32}
            y={geo.yOf(t) + 3.5}
            textAnchor="end"
            fontFamily={PREVIEW_MONO}
            fontSize="10.5"
            fill={MUTED}
          >
            {t.toFixed(2)}
          </text>
        </g>
      ))}

      {geo.seedScore !== null ? (
        <>
          <line
            x1={geo.plot.left - 26}
            y1={geo.yOf(geo.seedScore)}
            x2={geo.plot.right + 40}
            y2={geo.yOf(geo.seedScore)}
            stroke="rgba(124, 99, 80, 0.5)"
            strokeWidth={1.1}
            strokeDasharray="6 5"
          />
          <text
            x={geo.plot.right + 40}
            y={geo.yOf(geo.seedScore) + 14}
            textAnchor="end"
            fontFamily={PREVIEW_SERIF}
            fontStyle="italic"
            fontSize="10.5"
            fill={MUTED}
          >
            {msg("trajectory.preview.baseline")}
          </text>
        </>
      ) : null}

      <g pointerEvents="none">
        <line
          x1={geo.plot.left - 26}
          y1={geo.yOf(geo.bestScore)}
          x2={geo.plot.right + 40}
          y2={geo.yOf(geo.bestScore)}
          stroke={SPINE_GOLD}
          strokeWidth={1}
          strokeDasharray="2 5"
          opacity={0.55}
        />
        <text
          x={geo.plot.right + 40}
          y={geo.yOf(geo.bestScore) - 6}
          textAnchor="end"
          fontFamily={PREVIEW_MONO}
          fontSize="10.5"
          fontWeight={700}
          fill={SPINE_GOLD}
        >
          {`${msg("trajectory.preview.best")} ${geo.bestScore.toFixed(2)}`}
        </text>
      </g>

      <text
        x={(geo.plot.left + geo.plot.right) / 2}
        y={geo.height - 20}
        textAnchor="middle"
        fontFamily={PREVIEW_SERIF}
        fontStyle="italic"
        fontSize="11.5"
        fill={MUTED}
      >
        {msg("trajectory.preview.axis_iteration")}
      </text>

      <g fill="none">
        {edges.map((edge, i) => {
          const from = geo.pos.get(edge.from);
          const to = geo.pos.get(edge.to);
          if (from === undefined || to === undefined) return null;
          const midX = (from.x + to.x) / 2;
          const onSpine = !edge.isMerge && spineIds.has(edge.from) && spineIds.has(edge.to);
          return (
            <path
              key={`${edge.from}-${edge.to}-${i}`}
              d={`M ${from.x} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${to.x} ${to.y}`}
              stroke={edge.isMerge ? BRANCH_STROKE : onSpine ? SPINE_GOLD : BRANCH_STROKE}
              strokeWidth={edge.isMerge ? 1.2 : onSpine ? 2.6 : 1.4}
              strokeDasharray={edge.isMerge ? "3 4" : undefined}
              strokeLinecap="round"
              opacity={edge.isMerge ? 0.8 : onSpine ? 1 : 0.85}
            />
          );
        })}
      </g>

      <g>
        {ghosts.map((ghost) => {
          const p = geo.ghostPos.get(ghost.rejection_id);
          if (p === undefined) return null;
          return (
            <g
              key={ghost.rejection_id}
              onClick={() => onSelectRejected(ghost.rejection_id)}
              style={{ cursor: "pointer" }}
            >
              <title>{msg("trajectory.ghost.legend")}</title>
              <circle cx={p.x} cy={p.y} r={8} fill="transparent" />
              <path
                d={`M ${p.x - 4} ${p.y - 4} l 8 8 m 0 -8 l -8 8`}
                stroke={GHOST_MARK}
                strokeWidth={1.5}
                fill="none"
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
          const { passes, total } = passStats(node);
          const frac = total > 0 ? passes / total : 0;
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
                  r={ARC_R + 4.5}
                  fill="none"
                  stroke={INK}
                  strokeWidth={1.2}
                />
              ) : null}
              {isWinner ? (
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={ARC_R + 6.5}
                  fill="none"
                  stroke={SPINE_GOLD}
                  strokeWidth={1.1}
                  strokeDasharray="2.5 3"
                />
              ) : null}
              {total > 0 ? (
                <>
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={ARC_R}
                    fill="none"
                    stroke={FAIL_TRACK}
                    strokeWidth={2.4}
                    opacity={0.3}
                  />
                  {frac >= 1 ? (
                    <circle
                      cx={p.x}
                      cy={p.y}
                      r={ARC_R}
                      fill="none"
                      stroke={PASS_ARC}
                      strokeWidth={2.4}
                      opacity={0.9}
                    />
                  ) : frac > 0 ? (
                    <path
                      d={passArcPath(p.x, p.y, ARC_R, frac)}
                      fill="none"
                      stroke={PASS_ARC}
                      strokeWidth={2.4}
                      strokeLinecap="round"
                      opacity={0.9}
                    />
                  ) : null}
                </>
              ) : null}
              <circle
                cx={p.x}
                cy={p.y}
                r={isWinner ? NODE_R + 1.5 : NODE_R}
                fill={isWinner ? WINNER_FILL : CORE_FILL}
                stroke={isWinner ? SPINE_GOLD : INK}
                strokeWidth={isWinner ? 2.2 : node.isOnSpine ? 1.4 : 1.1}
                opacity={node.isOnSpine || isWinner ? 1 : 0.9}
              />
              <text
                x={p.x + ARC_R + 7}
                y={p.y + 3.5}
                textAnchor="start"
                fontFamily={PREVIEW_MONO}
                fontSize="10"
                fontWeight={600}
                fill="rgba(28, 22, 18, 0.62)"
                stroke={LABEL_HALO}
                strokeWidth={2.5}
                strokeLinejoin="round"
                pointerEvents="none"
                style={{ paintOrder: "stroke" }}
              >
                {displayCandidateId(node.candidate_id)}
              </text>
              {isWinner ? (
                <g pointerEvents="none">
                  <rect
                    x={p.x - (winnerLabel.length * 3.4 + 10)}
                    y={p.y + ARC_R + 10}
                    width={winnerLabel.length * 6.8 + 20}
                    height={16}
                    rx={8}
                    fill={SPINE_GOLD}
                  />
                  <text
                    x={p.x}
                    y={p.y + ARC_R + 21.5}
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
