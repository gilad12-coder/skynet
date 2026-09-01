"use client";

import { memo } from "react";
import { formatBlackboxScore } from "@/shared/lib";
import { formatMsg, msg } from "@/shared/lib/messages";
import { cn } from "@/shared/lib/utils";
import { HelpTip } from "@/shared/ui/help-tip";
import type { ClimbModel } from "../lib/meta-harness";
import { displayCandidateId, displayCaseId } from "../lib/types";
import { caseShade } from "./TrajectoryDrawer";

export interface MetaHarnessCaseGridProps {
  model: ClimbModel;
  live: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

/**
 * Every version scored on every case, as a heatmap: one column per version,
 * one row per case, so a case that no rewrite ever cracks shows up as a dark
 * row and a version that traded one case for another as a mixed column. The
 * version being scored fills in cell by cell while the run is live.
 */
function MetaHarnessCaseGridImpl({ model, live, selectedId, onSelect }: MetaHarnessCaseGridProps) {
  const pending = live ? model.pending : null;
  if (model.caseIds.length === 0 || (model.versions.length === 0 && pending === null)) return null;

  const scores: number[] = [];
  const byVersion = new Map<string, Map<string, number>>();
  for (const version of model.versions) {
    const cells = new Map<string, number>();
    for (const entry of version.candidate.per_example) {
      cells.set(entry.id, entry.score);
      scores.push(entry.score);
    }
    byVersion.set(version.candidate.candidate_id, cells);
  }
  if (pending !== null) for (const score of pending.scores.values()) scores.push(score);
  const min = scores.length === 0 ? 0 : Math.min(...scores);
  const max = scores.length === 0 ? 1 : Math.max(...scores);
  const unit = scores.every((score) => score >= 0 && score <= 1);
  const pendingId = pending === null ? null : String(pending.index);

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <HelpTip text={msg("meta_harness.grid.explain")}>
          <span className="text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground">
            {msg("meta_harness.grid.title")}
          </span>
        </HelpTip>
        {scores.length > 0 ? (
          <span className="text-[10px] text-muted-foreground tabular-nums" dir="ltr">
            {formatMsg("trajectory.blackbox.cases.range", {
              min: formatBlackboxScore(min),
              max: formatBlackboxScore(max),
            })}
          </span>
        ) : null}
      </div>
      <div className="overflow-x-auto" dir="ltr">
        <table
          className="border-separate border-spacing-0.5 text-[10px]"
          aria-label={msg("meta_harness.grid.title")}
        >
          <thead>
            <tr>
              <th scope="col" className="sr-only">
                {msg("trajectory.blackbox.section.cases")}
              </th>
              {model.versions.map((version) => {
                const id = version.candidate.candidate_id;
                const isSelected = id === selectedId;
                return (
                  <th key={id} scope="col" className="p-0 align-bottom">
                    <button
                      type="button"
                      onClick={() => onSelect(id)}
                      aria-pressed={isSelected}
                      aria-label={formatMsg("meta_harness.version", { id: displayCandidateId(id) })}
                      className={cn(
                        "flex h-6 w-6 items-center justify-center rounded-sm font-mono font-semibold tabular-nums transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                        isSelected ? "bg-[#1c1612] text-[#faf8f5]" : "text-muted-foreground",
                      )}
                    >
                      {displayCandidateId(id)}
                    </button>
                  </th>
                );
              })}
              {pending !== null && pendingId !== null ? (
                <th scope="col" className="p-0 align-bottom">
                  <span
                    className="flex h-6 w-6 items-center justify-center rounded-sm font-mono font-semibold tabular-nums text-muted-foreground/70"
                    aria-label={formatMsg("meta_harness.a11y.pending_label", {
                      id: displayCandidateId(pendingId),
                      done: pending.scores.size,
                      total: pending.total,
                    })}
                  >
                    {displayCandidateId(pendingId)}
                  </span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {model.caseIds.map((caseId) => (
              <tr key={caseId}>
                <th
                  scope="row"
                  className="pe-2 text-start font-mono font-medium tabular-nums text-muted-foreground"
                >
                  {formatMsg("trajectory.blackbox.cases.case_label", { id: displayCaseId(caseId) })}
                </th>
                {model.versions.map((version) => {
                  const id = version.candidate.candidate_id;
                  const score = byVersion.get(id)?.get(caseId);
                  const isSelected = id === selectedId;
                  if (score === undefined) {
                    return <td key={id} className="p-0" aria-hidden="true" />;
                  }
                  const shade = caseShade(score, min, max, unit);
                  const label = formatMsg("meta_harness.grid.cell_label", {
                    id: displayCandidateId(id),
                    case: displayCaseId(caseId),
                    score: formatBlackboxScore(score),
                  });
                  return (
                    <td key={id} className="p-0">
                      <button
                        type="button"
                        onClick={() => onSelect(id)}
                        aria-label={label}
                        title={label}
                        className={cn(
                          "block h-6 w-6 rounded-sm transition-[box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                          isSelected &&
                            "ring-2 ring-[#1c1612]/70 ring-offset-1 ring-offset-background",
                        )}
                        style={{ background: shade.background }}
                      />
                    </td>
                  );
                })}
                {pending !== null && pendingId !== null ? (
                  <td className="p-0">
                    {pending.scores.has(caseId) ? (
                      <span
                        role="img"
                        aria-label={formatMsg("meta_harness.grid.cell_label", {
                          id: displayCandidateId(pendingId),
                          case: displayCaseId(caseId),
                          score: formatBlackboxScore(pending.scores.get(caseId) ?? 0),
                        })}
                        className="block h-6 w-6 rounded-sm"
                        style={{
                          background: caseShade(pending.scores.get(caseId) ?? 0, min, max, unit)
                            .background,
                        }}
                      />
                    ) : (
                      <span
                        role="img"
                        aria-label={formatMsg("meta_harness.grid.pending_cell_label", {
                          id: displayCandidateId(pendingId),
                          case: displayCaseId(caseId),
                        })}
                        className="block h-6 w-6 animate-pulse rounded-sm border border-dashed border-[#7C6350]/40 bg-muted/60"
                      />
                    )}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export const MetaHarnessCaseGrid = memo(MetaHarnessCaseGridImpl);
