"use client";

import type { KeyboardEvent } from "react";
import { CaretLeft, CaretRight } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import { cn } from "@/shared/lib/utils";
import { formatMsg, msg } from "@/shared/lib/messages";
import { formatBlackboxDelta, formatBlackboxScore } from "../lib/blackbox";
import type { CandidateVersion } from "../lib/blackbox-versions";

// Same tints the Changes view uses for added / removed lines, so a positive
// delta reads as "gained" and a negative one as "lost".
const GAIN_FG = "#3f4d1f";
const LOSS_FG = "#6e2e16";

function barHeight(score: number | null, min: number, span: number): number {
  if (score == null) return 6;
  return 8 + Math.round(20 * ((score - min) / span));
}

/**
 * Stepper plus timeline for the run's versions. The rail always runs
 * left-to-right — older on the left — so ← and → mean the same thing in
 * every locale, and the diff and code views are laid out the same way.
 */
export function VersionRail({
  versions,
  index,
  onSelect,
}: {
  versions: CandidateVersion[];
  index: number;
  onSelect: (index: number) => void;
}) {
  const current = versions[index];
  const previous = index > 0 ? versions[index - 1] : null;
  if (!current) return null;
  const scores = versions.flatMap((v) => (v.score == null ? [] : [v.score]));
  const min = scores.length ? Math.min(...scores) : 0;
  const span = scores.length ? Math.max(...scores) - min || 1 : 1;
  const delta =
    current.score != null && previous?.score != null ? current.score - previous.score : null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft" && index > 0) {
      event.preventDefault();
      onSelect(index - 1);
    } else if (event.key === "ArrowRight" && index < versions.length - 1) {
      event.preventDefault();
      onSelect(index + 1);
    }
  };

  return (
    <div
      className="flex flex-col gap-3 border-t border-border/50 pt-3 lg:flex-row lg:items-center lg:gap-4"
      dir="ltr"
      onKeyDown={onKeyDown}
    >
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => onSelect(index - 1)}
          disabled={index === 0}
          aria-label={msg("optimization.blackbox.versions.prev")}
        >
          <CaretLeft className="size-4" aria-hidden="true" />
        </Button>
        <span className="min-w-[6rem] text-center text-xs tabular-nums text-muted-foreground">
          <span className="font-semibold text-foreground">
            {formatMsg("optimization.blackbox.versions.label", { n: current.number })}
          </span>
          {" · "}
          {formatMsg("optimization.blackbox.versions.position", {
            index: index + 1,
            total: versions.length,
          })}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => onSelect(index + 1)}
          disabled={index === versions.length - 1}
          aria-label={msg("optimization.blackbox.versions.next")}
        >
          <CaretRight className="size-4" aria-hidden="true" />
        </Button>
      </div>

      <div
        className="flex h-9 min-w-0 flex-1 items-end gap-[3px] overflow-x-auto px-1"
        role="group"
        aria-label={msg("optimization.blackbox.versions.rail")}
        title={msg("optimization.blackbox.versions.rail")}
      >
        {versions.map((version, i) => {
          const label = formatMsg("optimization.blackbox.versions.rail_item", {
            n: version.number,
            score: formatBlackboxScore(version.score),
          });
          return (
            <button
              key={version.number}
              type="button"
              onClick={() => onSelect(i)}
              aria-label={label}
              aria-current={i === index ? "true" : undefined}
              title={
                version.isBest ? `${label} · ${msg("optimization.blackbox.versions.best")}` : label
              }
              className={cn(
                "shrink-0 cursor-pointer rounded-sm transition-[height,background-color] hover:bg-primary/70",
                versions.length > 120 ? "w-1" : "w-1.5",
                i === index
                  ? "bg-primary ring-2 ring-primary/30"
                  : version.isBest
                    ? "bg-amber-500"
                    : version.isImprovement
                      ? "bg-primary/55"
                      : version.score == null
                        ? "bg-muted-foreground/20"
                        : "bg-muted-foreground/35",
              )}
              style={{ height: barHeight(version.score, min, span) }}
            />
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums">
        {current.score != null ? (
          <span className="font-medium">
            {formatMsg("optimization.blackbox.versions.score", {
              score: formatBlackboxScore(current.score),
            })}
          </span>
        ) : (
          <span className="text-muted-foreground">
            {msg("optimization.blackbox.versions.unscored")}
          </span>
        )}
        {delta != null && (
          <span style={{ color: delta >= 0 ? GAIN_FG : LOSS_FG }}>
            {formatMsg("optimization.blackbox.versions.delta_prev", {
              delta: formatBlackboxDelta(delta),
            })}
          </span>
        )}
        {current.firstRun != null && (
          <span className="text-muted-foreground">
            {formatMsg("optimization.blackbox.versions.first_seen", {
              run: current.firstRun,
              evals: current.evals,
            })}
          </span>
        )}
      </div>
    </div>
  );
}
