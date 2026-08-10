"use client";

import type { LayoutResult } from "../../lib/layout";
import { displayCandidateId, type TrajectoryNode } from "../../lib/types";
import { formatMsg } from "@/shared/lib/messages";

export const PREVIEW_HEIGHT_PX = 560;
export const PREVIEW_SURFACE_GRADIENT =
  "radial-gradient(circle at 50% 42%, var(--muted) 0%, var(--background) 58%)";
export const PREVIEW_MONO = "var(--font-mono, monospace)";
export const PREVIEW_SERIF = "'Iowan Old Style', Palatino, Georgia, serif";

export interface PreviewProps {
  layout: LayoutResult;
  selectedId: string | null;
  onSelectCandidate: (id: string) => void;
  onSelectRejected: (rejectionId: string) => void;
}

export function passStats(node: TrajectoryNode): { passes: number; total: number } {
  const total = node.per_example.length;
  let passes = 0;
  for (const ex of node.per_example) if (ex.score > 0) passes += 1;
  return { passes, total };
}

export function nodeA11yLabel(node: TrajectoryNode): string {
  return formatMsg("trajectory.a11y.node_label", {
    id: displayCandidateId(node.candidate_id),
    gen: node.generation,
    score: node.score.toFixed(2),
  });
}

export function PreviewFrame({
  width,
  height,
  background,
  label,
  children,
}: {
  width: number;
  height: number;
  background: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="relative w-full overflow-hidden rounded-xl border border-[#DDD4C8]/60"
      style={{ height: PREVIEW_HEIGHT_PX, background }}
      role="tree"
      aria-label={label}
    >
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${Math.max(width, 1)} ${Math.max(height, 1)}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ display: "block", direction: "ltr" }}
      >
        {children}
      </svg>
    </div>
  );
}
