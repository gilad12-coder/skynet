"use client";

import { CheckCircle, CircleNotch, Warning, XCircle } from "@/shared/ui/icons";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/primitives/card";
import { Badge } from "@/shared/ui/primitives/badge";
import { FadeIn } from "@/shared/ui/motion";
import { HelpTip } from "@/shared/ui/help-tip";
import { tip } from "@/shared/lib/tooltips";
import { cn } from "@/shared/lib/utils";
import { formatMsg, msg } from "@/shared/lib/messages";
import { formatBlackboxScore, type LaneView } from "../lib/blackbox";

const PHASE_LABEL: Record<LaneView["phase"], () => string> = {
  explore: () => msg("optimization.blackbox.lane.phase_explore"),
  continue: () => msg("optimization.blackbox.lane.phase_continue"),
  single: () => msg("optimization.blackbox.lane.phase_single"),
};

const STATUS_LABEL: Record<LaneView["status"], () => string> = {
  running: () => msg("optimization.blackbox.lane.status_running"),
  completed: () => msg("optimization.blackbox.lane.status_completed"),
  failed: () => msg("optimization.blackbox.lane.status_failed"),
  unavailable: () => msg("optimization.blackbox.lane.status_unavailable"),
  budget_exhausted: () => msg("optimization.blackbox.lane.status_budget_exhausted"),
};

function StatusIcon({ status }: { status: LaneView["status"] }) {
  if (status === "running")
    return <CircleNotch className="size-3.5 animate-spin text-primary" aria-hidden="true" />;
  if (status === "completed")
    return <CheckCircle className="size-3.5 text-[var(--success)]" aria-hidden="true" />;
  if (status === "failed")
    return <XCircle className="size-3.5 text-[var(--danger)]" aria-hidden="true" />;
  return <Warning className="size-3.5 text-muted-foreground" aria-hidden="true" />;
}

export function LaneBand({ lanes, engineUsed }: { lanes: LaneView[]; engineUsed?: string | null }) {
  if (lanes.length === 0) return null;
  return (
    <FadeIn delay={0.05}>
      <Card className="relative overflow-hidden shadow-[0_1px_3px_rgba(28,22,18,0.04),inset_0_1px_0_rgba(255,255,255,0.5)]">
        <CardHeader>
          <CardTitle className="text-base">
            <HelpTip text={tip("blackbox.lanes")}>
              <span className="font-bold tracking-tight">
                {msg("optimization.blackbox.lane.title")}
              </span>
            </HelpTip>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {lanes.map((lane, i) => {
              const winner =
                engineUsed != null && lane.engine === engineUsed && lane.status === "completed";
              return (
                <li
                  key={`${lane.engine}-${lane.phase}-${i}`}
                  className={cn(
                    "rounded-lg border p-3 text-sm",
                    winner ? "border-primary/40 bg-primary/5" : "border-border/50 bg-card/60",
                    lane.status === "running" && "border-primary/30",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5 font-semibold">
                      <StatusIcon status={lane.status} />
                      <span className="truncate font-mono">{lane.engine}</span>
                    </span>
                    <Badge variant="outline" size="sm" className="shrink-0">
                      {PHASE_LABEL[lane.phase]()}
                    </Badge>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>{STATUS_LABEL[lane.status]()}</span>
                    {lane.best_score != null && (
                      <span className="tabular-nums">
                        {formatMsg("optimization.blackbox.lane.best", {
                          score: formatBlackboxScore(lane.best_score),
                        })}
                      </span>
                    )}
                    {lane.scorer_runs != null && (
                      <span className="tabular-nums">
                        {formatMsg("optimization.blackbox.lane.runs", { n: lane.scorer_runs })}
                      </span>
                    )}
                    {lane.status === "running" && lane.budget != null && (
                      <span className="tabular-nums">
                        {formatMsg("optimization.blackbox.lane.budget", { n: lane.budget })}
                      </span>
                    )}
                  </div>
                  {lane.error && (
                    <p className="mt-1.5 break-words font-mono text-[0.6875rem] text-[var(--danger)]">
                      {lane.error}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
        </CardContent>
      </Card>
    </FadeIn>
  );
}
