"use client";

import { CaretDown, CaretLeft, CaretRight, Check, Trophy } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/primitives/dropdown-menu";
import { HelpTip } from "@/shared/ui/help-tip";
import { cn } from "@/shared/lib/utils";
import { formatMsg, msg } from "@/shared/lib/messages";
import { tip } from "@/shared/lib/tooltips";
import { formatBlackboxDelta, formatBlackboxScore } from "@/shared/lib";
import type { CandidateVersion } from "../lib/blackbox-versions";

function deltaFromPrevious(versions: CandidateVersion[], index: number): number | null {
  const current = versions[index]?.score;
  const previous = versions[index - 1]?.score;
  if (current == null || previous == null) return null;
  return current - previous;
}

/** What the headline score is made of — the validation sweep with the running mean beside it, or the mean alone. */
function scoreTip(version: CandidateVersion): string | null {
  if (version.meanScore == null || version.evals === 0) return null;
  if (version.score != null && version.score !== version.meanScore) {
    return formatMsg("optimization.blackbox.versions.score_tip.validation", {
      evals: version.evals,
      mean: formatBlackboxScore(version.meanScore),
    });
  }
  return formatMsg("optimization.blackbox.versions.score_tip.mean", { evals: version.evals });
}

function BestMark({ className }: { className?: string }) {
  return (
    <HelpTip text={tip("blackbox.versions.best")}>
      <span className={cn("inline-flex items-center gap-1 font-medium text-amber-700", className)}>
        <Trophy className="size-3 shrink-0" aria-hidden="true" />
        {msg("optimization.blackbox.versions.best")}
      </span>
    </HelpTip>
  );
}

function VersionRow({
  versions,
  index,
  selected,
  onSelect,
}: {
  versions: CandidateVersion[];
  index: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const version = versions[index];
  if (!version) return null;
  const delta = deltaFromPrevious(versions, index);
  const isLatest = versions.length > 1 && index === versions.length - 1;
  return (
    <DropdownMenuItem
      onSelect={onSelect}
      aria-current={selected ? "true" : undefined}
      className="gap-2 py-1.5 text-xs tabular-nums"
    >
      <Check
        className={cn("size-3.5 shrink-0 text-primary", !selected && "invisible")}
        aria-hidden="true"
      />
      <span className={cn("w-8 shrink-0 font-mono", selected && "font-semibold")}>
        {formatMsg("optimization.blackbox.versions.label", { n: version.number })}
      </span>
      <span className={version.score == null ? "text-muted-foreground/60" : undefined}>
        {formatBlackboxScore(version.score)}
      </span>
      {delta != null && (
        <span className="text-muted-foreground/80">{formatBlackboxDelta(delta)}</span>
      )}
      <span className="ms-auto flex shrink-0 items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
        {version.isBest && <BestMark />}
        {isLatest && <span>{msg("optimization.blackbox.versions.latest")}</span>}
        {version.isSeed && <span>{msg("optimization.blackbox.versions.starting_point")}</span>}
      </span>
    </DropdownMenuItem>
  );
}

/**
 * The window's version control: a ‹ v4 · 0.65 › stepper whose label opens
 * the full list (newest first), plus a "Best" mark when the shown version is
 * the winner. Always laid out left-to-right — older on the left — so ← and →
 * mean the same thing in every locale.
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
  if (!current) return null;
  const newestFirst = versions.map((_, i) => versions.length - 1 - i);
  const tipText = scoreTip(current);
  const scoreLabel = (
    <span className="text-muted-foreground">
      {"· "}
      {formatBlackboxScore(current.score)}
    </span>
  );

  // The end buttons stay focusable when there is nothing further to step to:
  // a `disabled` button drops focus to the page and the arrow keys stop working
  // right after the reader reaches either end.
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2" dir="ltr">
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => index > 0 && onSelect(index - 1)}
          aria-disabled={index === 0}
          className={cn(index === 0 && "pointer-events-none opacity-50")}
          aria-label={msg("optimization.blackbox.versions.prev")}
        >
          <CaretLeft aria-hidden="true" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              id="blackbox-version-trigger"
              variant="ghost"
              size="xs"
              className="px-1.5 font-normal tabular-nums"
            >
              <span className="font-semibold text-foreground">
                {formatMsg("optimization.blackbox.versions.label", { n: current.number })}
              </span>
              {tipText ? (
                <HelpTip text={tipText} className="cursor-pointer">
                  {scoreLabel}
                </HelpTip>
              ) : (
                scoreLabel
              )}
              <span className="sr-only">
                {msg("optimization.blackbox.versions.pick")}
                {" · "}
                {formatMsg("optimization.blackbox.versions.position", {
                  index: index + 1,
                  total: versions.length,
                })}
              </span>
              <CaretDown className="size-3 text-muted-foreground" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72 overflow-hidden p-0">
            <div className="max-h-72 overflow-y-auto py-1" dir="ltr">
              {newestFirst.map((i) => (
                <VersionRow
                  key={versions[i]?.number ?? i}
                  versions={versions}
                  index={i}
                  selected={i === index}
                  onSelect={() => onSelect(i)}
                />
              ))}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => index < versions.length - 1 && onSelect(index + 1)}
          aria-disabled={index === versions.length - 1}
          className={cn(index === versions.length - 1 && "pointer-events-none opacity-50")}
          aria-label={msg("optimization.blackbox.versions.next")}
        >
          <CaretRight aria-hidden="true" />
        </Button>
      </div>

      {current.isBest && <BestMark className="hidden text-[0.6875rem] sm:inline-flex" />}
    </div>
  );
}
