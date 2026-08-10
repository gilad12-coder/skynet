"use client";

import { useMemo } from "react";
import { msg } from "@/shared/lib/messages";
import { displayCandidateId } from "../../lib/types";
import { computeFigureGeometry } from "./figure-geometry";
import {
  nodeA11yLabel,
  PreviewFrame,
  PREVIEW_MONO,
  PREVIEW_SERIF,
  type PreviewProps,
} from "./preview-shared";

const INK = "#1C1612";
const SPINE_STROKE = "#3D2E22";
const BRANCH_STROKE = "#C2B49F";
const MERGE_STROKE = "#A89579";
const GHOST_MARK = "#C2B49F";
const BASELINE_STROKE = "#B7A894";
const GRID_STROKE = "#EEE8DC";
const MUTED = "#8C7A6B";
const WINNER_GOLD = "#9C7A3F";
const POINT_FILL = "#FDFAF4";

export function FigurePreview({
  layout,
  selectedId,
  onSelectCandidate,
  onSelectRejected,
}: PreviewProps) {
  const geo = useMemo(() => computeFigureGeometry(layout), [layout]);
  const { nodes, ghosts, edges, spineIds, winnerId } = layout;
  if (nodes.length === 0) return null;
  const winnerPos = winnerId !== null ? geo.pos.get(winnerId) : undefined;

  return (
    <PreviewFrame
      width={geo.width}
      height={geo.height}
      background="var(--background)"
      label={msg("trajectory.a11y.tree_label")}
    >
      {geo.ticks.map((t) => (
        <g key={`tick-${t}`}>
          <line
            x1={geo.plot.left}
            y1={geo.yOf(t)}
            x2={geo.plot.right}
            y2={geo.yOf(t)}
            stroke={GRID_STROKE}
            strokeWidth={1}
          />
          <text
            x={geo.plot.left - 10}
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
            x1={geo.plot.left}
            y1={geo.yOf(geo.seedScore)}
            x2={geo.plot.right}
            y2={geo.yOf(geo.seedScore)}
            stroke={BASELINE_STROKE}
            strokeWidth={1.1}
            strokeDasharray="6 5"
          />
          <text
            x={geo.plot.right}
            y={geo.yOf(geo.seedScore) - 6}
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

      <line
        x1={geo.plot.left}
        y1={geo.plot.top - 6}
        x2={geo.plot.left}
        y2={geo.plot.bottom}
        stroke={INK}
        strokeWidth={1.2}
      />
      <line
        x1={geo.plot.left}
        y1={geo.plot.bottom}
        x2={geo.plot.right + 12}
        y2={geo.plot.bottom}
        stroke={INK}
        strokeWidth={1.2}
      />
      <text
        x={(geo.plot.left + geo.plot.right) / 2}
        y={geo.height - 22}
        textAnchor="middle"
        fontFamily={PREVIEW_SERIF}
        fontStyle="italic"
        fontSize="11.5"
        fill={MUTED}
      >
        {msg("trajectory.preview.axis_iteration")}
      </text>
      <text
        x={30}
        y={(geo.plot.top + geo.plot.bottom) / 2}
        textAnchor="middle"
        transform={`rotate(-90 30 ${(geo.plot.top + geo.plot.bottom) / 2})`}
        fontFamily={PREVIEW_SERIF}
        fontStyle="italic"
        fontSize="11.5"
        fill={MUTED}
      >
        {msg("trajectory.preview.axis_score")}
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
              stroke={edge.isMerge ? MERGE_STROKE : onSpine ? SPINE_STROKE : BRANCH_STROKE}
              strokeWidth={edge.isMerge ? 1.1 : onSpine ? 1.9 : 1.2}
              strokeDasharray={edge.isMerge ? "3 4" : undefined}
              strokeLinecap="round"
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
                <circle cx={p.x} cy={p.y} r={10} fill="none" stroke={INK} strokeWidth={1.2} />
              ) : null}
              <circle
                cx={p.x}
                cy={p.y}
                r={isWinner ? 6.5 : 4.5}
                fill={isWinner ? WINNER_GOLD : POINT_FILL}
                stroke={isWinner ? INK : node.isOnSpine ? INK : MUTED}
                strokeWidth={isWinner ? 1.4 : node.isOnSpine ? 1.6 : 1.3}
              />
              <text
                x={p.x}
                y={p.y - 10}
                textAnchor="middle"
                fontFamily={PREVIEW_MONO}
                fontSize="9"
                fill="rgba(28, 22, 18, 0.55)"
                pointerEvents="none"
              >
                {displayCandidateId(node.candidate_id)}
              </text>
            </g>
          );
        })}
      </g>

      {winnerPos !== undefined && winnerId !== null ? (
        <g pointerEvents="none">
          <line
            x1={winnerPos.x - 6}
            y1={winnerPos.y + 8}
            x2={winnerPos.x - 34}
            y2={winnerPos.y + 34}
            stroke={MUTED}
            strokeWidth={0.9}
          />
          <text
            x={winnerPos.x - 38}
            y={winnerPos.y + 46}
            textAnchor="end"
            fontFamily={PREVIEW_MONO}
            fontSize="11.5"
            fontWeight={700}
            fill="#5E4222"
          >
            {`${displayCandidateId(winnerId)} — ${geo.bestScore.toFixed(2)}`}
          </text>
        </g>
      ) : null}
    </PreviewFrame>
  );
}
