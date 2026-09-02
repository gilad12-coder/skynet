"use client";

import { memo } from "react";
import { TrendUp, Trophy } from "@/shared/ui/icons";
import { formatBlackboxScore } from "@/shared/lib";
import { formatMsg, msg } from "@/shared/lib/messages";
import { cn } from "@/shared/lib/utils";
import type { ClimbModel } from "../lib/meta-harness";
import { displayCandidateId } from "../lib/types";

export interface MetaHarnessOutlineProps {
  model: ClimbModel;
  live: boolean;
  selectedId: string | null;
  newestId: string | null;
  onSelect: (id: string) => void;
}

/**
 * Lite-mode stand-in for the SVG climb: one row per version in the order it
 * was scored, marking the ones that beat the best before them, plus the
 * version being scored. Rows open the same drawer the chart does.
 */
function MetaHarnessOutlineImpl({
  model,
  live,
  selectedId,
  newestId,
  onSelect,
}: MetaHarnessOutlineProps) {
  const pending = live ? model.pending : null;
  return (
    <ul className="space-y-1">
      {model.versions.map((version) => {
        const id = version.candidate.candidate_id;
        const isWinner = id === model.bestId;
        const isSelected = id === selectedId;
        const isNewest = id === newestId;
        return (
          <li key={id}>
            <button
              type="button"
              onClick={() => onSelect(id)}
              className={cn(
                "flex w-full items-center gap-2 rounded-lg border px-3 py-1.5 text-start",
                isSelected
                  ? "border-[#B04030]/40 bg-[#B04030]/[0.05]"
                  : "border-border bg-card hover:bg-accent/60",
              )}
            >
              {isWinner ? (
                <Trophy
                  className="size-3.5 shrink-0 text-[#B07A30]"
                  aria-label={msg("trajectory.outline.best")}
                />
              ) : version.improved ? (
                <TrendUp
                  className="size-3.5 shrink-0 text-[#7C8B5A]"
                  aria-label={msg("meta_harness.legend.improved")}
                />
              ) : (
                <span className="inline-block size-3.5 shrink-0" aria-hidden="true" />
              )}
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                {formatMsg("meta_harness.version", { id: displayCandidateId(id) })}
                {isNewest && (
                  <span
                    className="ms-2 inline-block size-1.5 rounded-full bg-[#B04030] align-middle"
                    aria-hidden="true"
                  />
                )}
              </span>
              <span
                className={cn(
                  "shrink-0 font-mono text-xs tabular-nums",
                  version.improved ? "text-[#5f6d3f]" : "text-muted-foreground",
                )}
                dir="ltr"
              >
                {formatBlackboxScore(version.score)}
              </span>
            </button>
          </li>
        );
      })}
      {pending !== null ? (
        <li>
          <button
            type="button"
            onClick={() => onSelect(String(pending.index))}
            aria-pressed={String(pending.index) === selectedId}
            className={cn(
              "flex w-full items-center gap-2 rounded-lg border border-dashed px-3 py-1.5 text-start text-sm text-muted-foreground",
              String(pending.index) === selectedId
                ? "border-[#B04030]/40 bg-[#B04030]/[0.05]"
                : "border-[#7C6350]/40 hover:bg-accent/60",
            )}
          >
            <span
              className="inline-block size-1.5 shrink-0 animate-pulse rounded-full bg-[var(--warning)]"
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 truncate" aria-live="polite">
              {formatMsg("meta_harness.live.scoring", {
                id: displayCandidateId(String(pending.index)),
                done: pending.scores.size,
                total: pending.total,
              })}
            </span>
          </button>
        </li>
      ) : null}
    </ul>
  );
}

export const MetaHarnessOutline = memo(MetaHarnessOutlineImpl);
