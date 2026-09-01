"use client";

import { motion, useReducedMotion } from "framer-motion";
import { ArrowsIn, ArrowsOut } from "@/shared/ui/icons";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { formatBlackboxScore } from "@/shared/lib";
import { formatMsg, msg } from "@/shared/lib/messages";
import { TERMS } from "@/shared/lib/terms";
import { cn } from "@/shared/lib/utils";
import {
  Tooltip as UiTooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/shared/ui/primitives/tooltip";
import {
  CLIMB_LAYOUT,
  layoutClimb,
  type ClimbLayout,
  type ClimbModel,
  type ClimbPoint,
} from "../lib/meta-harness";
import { displayCandidateId } from "../lib/types";

// The palette mirrors TrajectoryTree so a climb and a tree read as one family.
const EDGE_STROKE = "rgba(124, 99, 80, 0.42)";
const NODE_CORE_FILL = "#fdfaf4";
const NODE_CORE_STROKE = "rgba(28, 22, 18, 0.16)";
const NODE_CORE_STROKE_HOVER = "rgba(28, 22, 18, 0.42)";
const NODE_CORE_STROKE_SELECTED = "#1c1612";
const IMPROVED_FILL = "#7C8B5A";
const REGRESSED_FILL = "#B26B4A";
const SCORE_TRACK_STROKE = "rgba(124, 99, 80, 0.14)";
const PENDING_STROKE = "rgba(124, 99, 80, 0.6)";
const PENDING_PROGRESS = "#7C6350";
const WINNER_INDICATOR = "#9C7A3F";
const WINNER_HALO = "rgba(156, 122, 63, 0.18)";
const WINNER_FILL = "#F8EBC8";
const WINNER_BADGE_FILL = "#9C7A3F";
const WINNER_BADGE_INK = "#FBF4DF";
const LABEL_HALO = "rgba(250, 248, 245, 0.9)";
const GRID_LINE_COLOR = "oklch(0.91 0.006 50)";
const AXIS_INK = "rgba(28, 22, 18, 0.55)";
const SURFACE_GRADIENT = "radial-gradient(ellipse at 50% 0%, var(--muted), var(--background) 70%)";
// Room under the plot for the legend that floats over the chart's bottom edge.
const LEGEND_ROOM_PX = 48;

const RING_R = CLIMB_LAYOUT.nodeRadius - CLIMB_LAYOUT.ringThickness / 2;
const INNER_R = CLIMB_LAYOUT.nodeRadius - CLIMB_LAYOUT.ringThickness;

interface LayerVisibility {
  best: boolean;
  lineage: boolean;
  winner: boolean;
}

export interface MetaHarnessClimbProps {
  model: ClimbModel;
  live: boolean;
  selectedId: string | null;
  newestId: string | null;
  onSelect: (id: string) => void;
}

function edgePath(from: { x: number; y: number }, to: { x: number; y: number }): string {
  const midX = (from.x + to.x) / 2;
  return `M ${from.x} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${to.x} ${to.y}`;
}

function stairPath(points: ClimbLayout["bestPath"]): string {
  return points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
}

function ringFraction(score: number, domain: ClimbLayout["domain"]): number {
  const t = domain.unit ? score : (score - domain.min) / (domain.max - domain.min);
  return Math.max(0, Math.min(1, t));
}

// A stroked circle normalised to one unit of path length: the dash offset
// rotates the arc to start at 12 o'clock (a circle's path begins at 3 o'clock).
function arc(cx: number, cy: number, r: number, width: number, color: string, fraction: number) {
  if (fraction <= 0) return null;
  const full = fraction >= 1;
  return (
    <circle
      cx={cx}
      cy={cy}
      r={r}
      fill="none"
      stroke={color}
      strokeWidth={width}
      pathLength={1}
      strokeDasharray={full ? undefined : `${fraction} ${1 - fraction}`}
      strokeDashoffset={full ? undefined : -0.75}
    />
  );
}

/**
 * The meta-harness run as a climb: versions left to right in the order they
 * were scored, height by score, the best so far drawn as a staircase and each
 * version tied to the version it was rewritten from. Nothing branches, so the
 * chart scrolls sideways instead of panning: the tree's map controls would be
 * noise here.
 */
export function MetaHarnessClimb({
  model,
  live,
  selectedId,
  newestId,
  onSelect,
}: MetaHarnessClimbProps) {
  const reduceMotion = useReducedMotion() === true;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [isMaximized, setIsMaximized] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [layers, setLayers] = useState<LayerVisibility>({
    best: true,
    lineage: true,
    winner: true,
  });
  const toggleLayer = useCallback((key: keyof LayerVisibility) => {
    setLayers((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
    // The maximize toggle moves the container through a portal, so the
    // observer has to re-attach to the new host element.
  }, [isMaximized]);

  useEffect(() => {
    if (!isMaximized) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setIsMaximized(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [isMaximized]);

  const layout = useMemo(
    () => layoutClimb(model, { availableWidth: width, showPending: live }),
    [model, width, live],
  );
  const svgWidth = Math.max(layout.width, width);
  const svgHeight = layout.height + LEGEND_ROOM_PX;
  const bestPoint = useMemo(
    () => layout.points.find((p) => p.id === model.bestId) ?? null,
    [layout.points, model.bestId],
  );

  const body = (
    <div
      ref={containerRef}
      className={
        isMaximized
          ? "fixed inset-0 z-50 flex h-screen w-screen flex-col overflow-hidden border-0"
          : "relative w-full overflow-hidden rounded-xl border border-[#DDD4C8]/60"
      }
      style={{ background: SURFACE_GRADIENT }}
    >
      <div
        dir="ltr"
        className={cn(
          "overflow-x-auto overflow-y-hidden",
          isMaximized && "flex min-h-0 flex-1 items-center",
        )}
      >
        <svg
          width={svgWidth}
          height={svgHeight}
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          role="group"
          aria-label={msg("meta_harness.a11y.chart_label")}
          className="block select-none"
          style={{ minWidth: layout.width }}
        >
          <g aria-hidden="true">
            {layout.ticks.map((tick) => (
              <g key={tick.value}>
                <line
                  x1={CLIMB_LAYOUT.padStart - CLIMB_LAYOUT.nodeRadius - 6}
                  x2={svgWidth}
                  y1={tick.y}
                  y2={tick.y}
                  stroke={GRID_LINE_COLOR}
                  strokeWidth={1}
                />
                <text
                  x={CLIMB_LAYOUT.padStart - CLIMB_LAYOUT.nodeRadius - 12}
                  y={tick.y + 3.5}
                  textAnchor="end"
                  fontFamily="var(--font-mono, monospace)"
                  fontSize="10"
                  fill={AXIS_INK}
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {formatBlackboxScore(tick.value)}
                </text>
              </g>
            ))}
            <text
              x={CLIMB_LAYOUT.padStart - CLIMB_LAYOUT.nodeRadius - 12}
              y={CLIMB_LAYOUT.padTop - 18}
              textAnchor="end"
              fontFamily='"Heebo", "Assistant", system-ui, sans-serif'
              fontSize="10"
              fontWeight={600}
              fill={AXIS_INK}
            >
              {msg("meta_harness.axis.score")}
            </text>
            <text
              x={CLIMB_LAYOUT.padStart - CLIMB_LAYOUT.nodeRadius - 6}
              y={layout.height - 10}
              textAnchor="start"
              fontFamily='"Heebo", "Assistant", system-ui, sans-serif'
              fontSize="10"
              fontWeight={600}
              fill={AXIS_INK}
            >
              {msg("meta_harness.axis.version")} →
            </text>
          </g>

          <ClimbContent
            layout={layout}
            model={model}
            bestPoint={bestPoint}
            layers={layers}
            selectedId={selectedId}
            hoveredId={hoveredId}
            newestId={newestId}
            reduceMotion={reduceMotion}
            onSelect={onSelect}
            onHover={setHoveredId}
          />
        </svg>
      </div>

      <div
        data-trajectory-controls
        className={
          isMaximized
            ? "absolute top-4 start-4 z-20 flex overflow-hidden rounded-lg border border-border/70 bg-background/95 shadow-md backdrop-blur-sm"
            : "absolute top-3 end-3 z-20 flex overflow-hidden rounded-lg border border-border/70 bg-background/90 shadow-sm backdrop-blur-sm"
        }
      >
        <MapControlButton
          label={
            isMaximized
              ? msg("trajectory.controls.fullscreen_exit")
              : msg("trajectory.controls.fullscreen_enter")
          }
          onClick={() => setIsMaximized((v) => !v)}
        >
          {isMaximized ? (
            <ArrowsIn className="size-3.5" aria-hidden="true" />
          ) : (
            <ArrowsOut className="size-3.5" aria-hidden="true" />
          )}
        </MapControlButton>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center">
        <div className="pointer-events-auto inline-flex flex-wrap items-center gap-x-1 gap-y-1 rounded-lg border border-[#DDD4C8]/70 bg-background/85 px-2 py-1 text-[11px] font-medium text-muted-foreground/90 backdrop-blur-sm">
          <LegendItem
            swatch={<RingSwatch color={IMPROVED_FILL} />}
            label={msg("meta_harness.legend.improved")}
          />
          <LegendItem
            swatch={<RingSwatch color={REGRESSED_FILL} />}
            label={msg("meta_harness.legend.regressed")}
          />
          <LegendDivider />
          <LegendToggle
            pressed={layers.best}
            onToggle={() => toggleLayer("best")}
            swatch={
              <svg className="h-2.5 w-4" viewBox="0 0 16 10" aria-hidden="true">
                <path
                  d="M 1 8 L 6 8 L 6 3 L 15 3"
                  fill="none"
                  stroke={WINNER_INDICATOR}
                  strokeWidth="1.8"
                  strokeDasharray="3 2"
                />
              </svg>
            }
            label={msg("meta_harness.legend.best_line")}
          />
          <LegendDivider />
          <LegendToggle
            pressed={layers.lineage}
            onToggle={() => toggleLayer("lineage")}
            swatch={
              <svg className="h-2.5 w-4" viewBox="0 0 16 10" aria-hidden="true">
                <path
                  d="M 1 8 C 8 8, 8 2, 15 2"
                  fill="none"
                  stroke={EDGE_STROKE}
                  strokeWidth="1.6"
                />
              </svg>
            }
            label={msg("meta_harness.legend.lineage")}
          />
          <LegendDivider />
          <LegendToggle
            pressed={layers.winner}
            onToggle={() => toggleLayer("winner")}
            swatch={
              <span
                className="inline-block h-2.5 w-4 rounded-[2px]"
                style={{ background: WINNER_BADGE_FILL }}
              />
            }
            label={TERMS.winningCandidate}
          />
        </div>
      </div>
    </div>
  );

  if (isMaximized && typeof document !== "undefined") {
    return (
      <>
        <div
          aria-hidden="true"
          className="w-full rounded-xl border border-[#DDD4C8]/60 opacity-40"
          style={{ height: svgHeight, background: SURFACE_GRADIENT }}
        />
        {createPortal(body, document.body)}
      </>
    );
  }
  return body;
}

interface ClimbContentProps {
  layout: ClimbLayout;
  model: ClimbModel;
  bestPoint: ClimbPoint | null;
  layers: LayerVisibility;
  selectedId: string | null;
  hoveredId: string | null;
  newestId: string | null;
  reduceMotion: boolean;
  onSelect: (id: string) => void;
  onHover: (id: string | null) => void;
}

const ClimbContent = memo(function ClimbContent({
  layout,
  model,
  bestPoint,
  layers,
  selectedId,
  hoveredId,
  newestId,
  reduceMotion,
  onSelect,
  onHover,
}: ClimbContentProps) {
  const R = CLIMB_LAYOUT.nodeRadius;
  const pending = layout.pending;
  const pendingDone = model.pending?.scores.size ?? 0;
  const pendingTotal = model.pending?.total ?? 0;
  const activate = (id: string) => (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(id);
    }
  };

  return (
    <>
      <LayerFade show={layers.lineage} reduceMotion={reduceMotion}>
        {layout.edges.map((edge) => (
          <motion.path
            key={`edge-${edge.to.id}`}
            d={edgePath(edge.from, edge.to)}
            fill="none"
            stroke={EDGE_STROKE}
            strokeWidth={1.4}
            initial={reduceMotion ? false : { pathLength: 0, opacity: 0 }}
            animate={reduceMotion ? undefined : { pathLength: 1, opacity: 1 }}
            transition={reduceMotion ? undefined : { duration: 0.5, ease: "easeOut" }}
          />
        ))}
        {pending !== null && bestPoint !== null ? (
          <path
            d={edgePath(bestPoint, pending)}
            fill="none"
            stroke={EDGE_STROKE}
            strokeWidth={1.2}
            strokeDasharray="3 3"
          />
        ) : null}
      </LayerFade>

      <LayerFade show={layers.best} reduceMotion={reduceMotion}>
        {layout.bestPath.length > 1 ? (
          <motion.path
            d={stairPath(layout.bestPath)}
            fill="none"
            stroke={WINNER_INDICATOR}
            strokeWidth={1.8}
            strokeDasharray="5 4"
            strokeLinejoin="round"
            opacity={0.8}
            initial={reduceMotion ? false : { pathLength: 0 }}
            animate={reduceMotion ? undefined : { pathLength: 1 }}
            transition={reduceMotion ? undefined : { duration: 0.6, ease: "easeOut" }}
          />
        ) : null}
      </LayerFade>

      <g>
        {layout.points.map((point) => {
          const { version } = point;
          const isSelected = point.id === selectedId;
          const isHovered = point.id === hoveredId;
          const isNewest = point.id === newestId;
          const isWinner = point.id === model.bestId;
          const winnerShown = isWinner && layers.winner;
          const coreStroke = isSelected
            ? NODE_CORE_STROKE_SELECTED
            : isHovered
              ? NODE_CORE_STROKE_HOVER
              : NODE_CORE_STROKE;
          return (
            <motion.g
              key={point.id}
              role="button"
              aria-label={formatMsg("meta_harness.a11y.node_label", {
                id: displayCandidateId(point.id),
                score: formatBlackboxScore(version.score),
              })}
              aria-pressed={isSelected}
              tabIndex={0}
              onMouseEnter={() => onHover(point.id)}
              onMouseLeave={() => onHover(null)}
              onClick={() => onSelect(point.id)}
              onKeyDown={activate(point.id)}
              initial={reduceMotion ? false : { scale: isNewest ? 0 : 0.7, opacity: 0 }}
              animate={reduceMotion ? undefined : { scale: 1, opacity: 1 }}
              transition={reduceMotion ? undefined : { duration: 0.45, ease: [0.2, 0.8, 0.2, 1] }}
              style={{ cursor: "pointer", transformOrigin: `${point.x}px ${point.y}px` }}
            >
              {isNewest && !reduceMotion ? (
                <motion.circle
                  cx={point.x}
                  cy={point.y}
                  r={R}
                  fill="none"
                  stroke={WINNER_INDICATOR}
                  strokeWidth="1.6"
                  initial={{ r: R, opacity: 0.6 }}
                  animate={{ r: R * 2.2, opacity: 0 }}
                  transition={{ duration: 1.2, ease: "easeOut", repeat: 2 }}
                />
              ) : null}
              {isSelected ? (
                <circle
                  cx={point.x}
                  cy={point.y}
                  r={R + 5}
                  fill="none"
                  stroke={NODE_CORE_STROKE_SELECTED}
                  strokeWidth={1.5}
                  strokeOpacity={0.7}
                />
              ) : null}
              {isWinner ? (
                <LayerFade show={layers.winner} reduceMotion={reduceMotion}>
                  <circle
                    cx={point.x}
                    cy={point.y}
                    r={R + 11}
                    fill="none"
                    stroke={WINNER_HALO}
                    strokeWidth={3}
                  />
                  {reduceMotion ? null : (
                    <motion.circle
                      cx={point.x}
                      cy={point.y}
                      r={R + 4}
                      fill="none"
                      stroke={WINNER_INDICATOR}
                      strokeWidth={1.4}
                      initial={{ opacity: 0.5, r: R + 4 }}
                      animate={{ opacity: [0.5, 0.12, 0.5], r: [R + 4, R + 10, R + 4] }}
                      transition={{ duration: 3.2, ease: "easeInOut", repeat: Infinity }}
                    />
                  )}
                  <circle
                    cx={point.x}
                    cy={point.y}
                    r={R + 4}
                    fill="none"
                    stroke={WINNER_INDICATOR}
                    strokeWidth={2.6}
                  />
                </LayerFade>
              ) : null}
              <circle
                cx={point.x}
                cy={point.y}
                r={RING_R}
                fill="none"
                stroke={SCORE_TRACK_STROKE}
                strokeWidth={CLIMB_LAYOUT.ringThickness}
              />
              {arc(
                point.x,
                point.y,
                RING_R,
                CLIMB_LAYOUT.ringThickness,
                version.improved ? IMPROVED_FILL : REGRESSED_FILL,
                ringFraction(version.score, layout.domain),
              )}
              <circle
                cx={point.x}
                cy={point.y}
                r={INNER_R}
                fill={winnerShown ? WINNER_FILL : NODE_CORE_FILL}
                stroke={coreStroke}
                strokeWidth={isSelected ? 1.4 : 0.8}
                style={{
                  transition: "fill 250ms ease, stroke 120ms ease, stroke-width 120ms ease",
                }}
              />
              <text
                x={point.x}
                y={point.y + 4.5}
                textAnchor="middle"
                fontFamily="var(--font-mono, monospace)"
                fontSize="13"
                fontWeight={700}
                fill="#1c1612"
                pointerEvents="none"
              >
                {displayCandidateId(point.id)}
              </text>
              {isWinner ? (
                <LayerFade show={layers.winner} reduceMotion={reduceMotion}>
                  <WinnerBadge x={point.x} y={point.y + R + 4} />
                </LayerFade>
              ) : null}
              <motion.g
                initial={false}
                animate={{ y: isWinner && !layers.winner ? -20 : 0 }}
                transition={reduceMotion ? { duration: 0 } : { duration: 0.25, ease: "easeOut" }}
              >
                <text
                  x={point.x}
                  y={point.y + R + (isWinner ? 34 : 14)}
                  textAnchor="middle"
                  fontFamily="var(--font-mono, monospace)"
                  fontSize="10.5"
                  fontWeight={600}
                  fill="rgba(28, 22, 18, 0.72)"
                  stroke={LABEL_HALO}
                  strokeWidth={2.5}
                  strokeLinejoin="round"
                  pointerEvents="none"
                  style={{ fontVariantNumeric: "tabular-nums", paintOrder: "stroke" }}
                >
                  {formatBlackboxScore(version.score)}
                </text>
              </motion.g>
            </motion.g>
          );
        })}

        {pending !== null && model.pending !== null ? (
          <motion.g
            key={`pending-${model.pending.index}`}
            role="img"
            aria-label={formatMsg("meta_harness.a11y.pending_label", {
              id: displayCandidateId(String(model.pending.index)),
              done: pendingDone,
              total: pendingTotal,
            })}
            initial={reduceMotion ? false : { opacity: 0, y: pending.y }}
            animate={{ opacity: 1, y: pending.y }}
            transition={reduceMotion ? { duration: 0 } : { duration: 0.6, ease: "easeOut" }}
          >
            {reduceMotion ? (
              <circle
                cx={pending.x}
                cy={0}
                r={R + 4}
                fill="none"
                stroke={PENDING_STROKE}
                strokeWidth={1.2}
                strokeDasharray="4 4"
              />
            ) : (
              <motion.circle
                cx={pending.x}
                cy={0}
                r={R + 4}
                fill="none"
                stroke={PENDING_STROKE}
                strokeWidth={1.2}
                pathLength={1}
                strokeDasharray="0.08 0.06"
                animate={{ strokeDashoffset: [0, -1] }}
                transition={{ duration: 6, ease: "linear", repeat: Infinity }}
              />
            )}
            <circle
              cx={pending.x}
              cy={0}
              r={RING_R}
              fill="none"
              stroke={SCORE_TRACK_STROKE}
              strokeWidth={CLIMB_LAYOUT.ringThickness}
            />
            {arc(
              pending.x,
              0,
              RING_R,
              CLIMB_LAYOUT.ringThickness,
              PENDING_PROGRESS,
              pendingTotal > 0 ? pendingDone / pendingTotal : 0,
            )}
            <circle
              cx={pending.x}
              cy={0}
              r={INNER_R}
              fill={NODE_CORE_FILL}
              stroke={NODE_CORE_STROKE}
              strokeWidth={0.8}
            />
            <text
              x={pending.x}
              y={4}
              textAnchor="middle"
              fontFamily="var(--font-mono, monospace)"
              fontSize="10.5"
              fontWeight={700}
              fill="#1c1612"
              pointerEvents="none"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {pendingDone}/{pendingTotal}
            </text>
            <text
              x={pending.x}
              y={R + 14}
              textAnchor="middle"
              fontFamily="var(--font-mono, monospace)"
              fontSize="10.5"
              fontWeight={600}
              fill="rgba(28, 22, 18, 0.72)"
              stroke={LABEL_HALO}
              strokeWidth={2.5}
              strokeLinejoin="round"
              pointerEvents="none"
              style={{ paintOrder: "stroke" }}
            >
              {displayCandidateId(String(model.pending.index))}
            </text>
          </motion.g>
        ) : null}
      </g>
    </>
  );
});

function LayerFade({
  show,
  reduceMotion,
  children,
}: {
  show: boolean;
  reduceMotion: boolean;
  children: React.ReactNode;
}) {
  return (
    <motion.g
      initial={false}
      animate={{ opacity: show ? 1 : 0 }}
      transition={reduceMotion ? { duration: 0 } : { duration: 0.25, ease: "easeOut" }}
      style={{ pointerEvents: show ? "auto" : "none" }}
    >
      {children}
    </motion.g>
  );
}

function WinnerBadge({ x, y }: { x: number; y: number }) {
  const label = msg("trajectory.node.winning_label");
  // SVG text can't auto-size its background rect, so estimate the label's
  // width from its glyph count (~5.6px per glyph at 9.5px bold Heebo).
  const w = Math.round(label.length * 5.6) + 14;
  const h = 16;
  const top = y + 4;
  return (
    <g pointerEvents="none">
      <rect x={x - w / 2} y={top} width={w} height={h} rx={3} ry={3} fill={WINNER_BADGE_FILL} />
      <text
        x={x}
        y={top + h / 2 + 3.4}
        textAnchor="middle"
        fontFamily='"Heebo", "Assistant", system-ui, sans-serif'
        fontSize="9.5"
        fontWeight={700}
        letterSpacing="0.4"
        fill={WINNER_BADGE_INK}
      >
        {label}
      </text>
    </g>
  );
}

function RingSwatch({ color }: { color: string }) {
  return (
    <svg className="size-2.5" viewBox="0 0 10 10" aria-hidden="true">
      <circle cx="5" cy="5" r="3.5" fill="none" stroke={SCORE_TRACK_STROKE} strokeWidth="3" />
      <circle
        cx="5"
        cy="5"
        r="3.5"
        fill="none"
        stroke={color}
        strokeWidth="3"
        pathLength={1}
        strokeDasharray="0.65 0.35"
        strokeDashoffset={-0.75}
      />
    </svg>
  );
}

function LegendItem({ swatch, label }: { swatch: React.ReactNode; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap px-1.5 py-0.5">
      {swatch}
      <span>{label}</span>
    </span>
  );
}

function LegendToggle({
  swatch,
  label,
  pressed,
  onToggle,
}: {
  swatch: React.ReactNode;
  label: string;
  pressed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onToggle}
      className={cn(
        "inline-flex min-h-[44px] cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 py-0.5 transition-[opacity,color,background-color] duration-150 hover:bg-accent/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 lg:min-h-0 [@media(hover:none)_and_(pointer:coarse)]:min-h-[44px]",
        !pressed && "opacity-40",
      )}
    >
      {swatch}
      <span>{label}</span>
    </button>
  );
}

function LegendDivider() {
  return <span aria-hidden="true" className="inline-block h-3 w-px bg-border/60" />;
}

function MapControlButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <UiTooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          className="inline-flex size-[44px] items-center justify-center text-foreground transition-[background-color,color] hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#C8A882]/45 lg:size-9 [@media(hover:none)_and_(pointer:coarse)]:size-[44px]"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={8}>
        {label}
      </TooltipContent>
    </UiTooltip>
  );
}
