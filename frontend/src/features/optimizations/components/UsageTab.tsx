"use client";

import { useEffect, useMemo, useState } from "react";
import { Coins, Stack } from "@/shared/ui/icons";
import { EmptyState } from "@/shared/ui/empty-state";
import { FadeIn } from "@/shared/ui/motion";
import { HelpTip } from "@/shared/ui/help-tip";
import { Segmented } from "@/shared/ui/segmented";
import { ExportTableMenu } from "@/shared/ui/export-table-menu";
import { Card, CardContent } from "@/shared/ui/primitives/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableInline,
  TableRow,
} from "@/shared/ui/primitives/table";
import { formatMsg, msg } from "@/shared/lib/messages";
import { tip, type TooltipKey } from "@/shared/lib/tooltips";
import { ACTIVE_STATUSES } from "@/shared/constants/job-status";
import { getActiveIntlLocale } from "@/shared/lib/runtime-locale";
import { getRunUsage } from "@/shared/lib/api";
import { formatBudgetUsd, formatCentsUsd } from "@/features/billing";
import type { OptimizationStatusResponse } from "@/shared/types/api";
import { cn } from "@/shared/lib/utils";
import { isBudgetPause, isBudgetStop } from "../lib/run-lifecycle";
import {
  availableGroupings,
  groupUsage,
  hasProviderSpend,
  UNATTRIBUTED,
  usageTotal,
  type RunUsage,
  type UsageGroup,
  type UsageGrouping,
} from "../lib/run-usage";
import { LiveMarker } from "./LogsTab";

const GROUPING_STORAGE_KEY = "skynet.usage.grouping";
/** Refresh interval while the run is going. */
const LIVE_REFRESH_MS = 2000;
/** Poll interval while a finished run's ledger is still settling. */
const SETTLE_POLL_MS = 5000;

const GROUPING_LABEL_KEYS = {
  role: "usage_tab.group.role",
  model: "usage_tab.group.model",
  stage: "usage_tab.group.stage",
  candidate: "usage_tab.group.candidate",
} as const;

const ROLE_LABEL_KEYS: Record<string, Parameters<typeof msg>[0]> = {
  task: "usage_tab.role.task",
  reflection: "usage_tab.role.reflection",
  proposer: "usage_tab.role.proposer",
  scorer: "usage_tab.role.scorer",
  sandbox: "usage_tab.role.sandbox",
  setup: "usage_tab.role.setup",
  other: "usage_tab.role.other",
  rounding: "usage_tab.role.rounding",
};

const ROLE_TIP_KEYS: Record<string, TooltipKey> = {
  task: "usage_tab.role.task",
  reflection: "usage_tab.role.reflection",
  proposer: "usage_tab.role.proposer",
  scorer: "usage_tab.role.scorer",
  sandbox: "usage_tab.role.sandbox",
  setup: "usage_tab.role.setup",
  other: "usage_tab.role.other",
  rounding: "usage_tab.role.rounding",
};

const GROUPING_TIP_KEYS: Record<UsageGrouping, TooltipKey> = {
  role: "usage_tab.group.role",
  model: "usage_tab.group.model",
  stage: "usage_tab.group.stage",
  candidate: "usage_tab.group.candidate",
};

const STAGE_TIP_KEYS: Record<string, TooltipKey> = {
  baseline: "lm_activity.stage.baseline",
  training: "lm_activity.stage.training",
  evaluation: "lm_activity.stage.evaluation",
  mutation: "usage_tab.stage.mutation",
  novelty_judge: "usage_tab.stage.novelty_judge",
  meta_notes: "usage_tab.stage.meta_notes",
  embedding: "usage_tab.stage.embedding",
};

const STAGE_LABEL_KEYS: Record<string, Parameters<typeof msg>[0]> = {
  baseline: "auto.features.optimizations.components.lmactivitytab.stage_baseline",
  training: "auto.features.optimizations.components.lmactivitytab.stage_training",
  evaluation: "auto.features.optimizations.components.lmactivitytab.stage_evaluation",
  // ShinkaEvolve tags each of its model calls with the step that made it.
  mutation: "usage_tab.stage.mutation",
  novelty_judge: "usage_tab.stage.novelty_judge",
  meta_notes: "usage_tab.stage.meta_notes",
  embedding: "usage_tab.stage.embedding",
};

function readGrouping(): UsageGrouping {
  try {
    const value = window.localStorage.getItem(GROUPING_STORAGE_KEY);
    if (value === "role" || value === "model" || value === "stage" || value === "candidate") {
      return value;
    }
  } catch {
    // Storage can be blocked; the default grouping is fine.
  }
  return "role";
}

function writeGrouping(grouping: UsageGrouping): void {
  try {
    window.localStorage.setItem(GROUPING_STORAGE_KEY, grouping);
  } catch {
    // Remembering the choice is a convenience only.
  }
}

function groupLabel(group: UsageGroup, grouping: UsageGrouping): string {
  if (group.nonModel || grouping === "role") {
    const key = ROLE_LABEL_KEYS[group.key];
    return key ? msg(key) : group.key;
  }
  if (group.key === UNATTRIBUTED) return msg("usage_tab.unattributed");
  if (grouping === "stage") {
    const key = STAGE_LABEL_KEYS[group.key];
    return key ? msg(key) : group.key;
  }
  return group.key;
}

function formatCount(n: number): string {
  return n.toLocaleString(getActiveIntlLocale());
}

function formatLatency(ms: number | null): string {
  if (ms == null) return msg("common.empty");
  const seconds = ms / 1000;
  if (seconds < 0.1) return msg("optimizations.duration.lt_0_1s");
  return formatMsg("optimizations.duration.seconds", { value: seconds.toFixed(1) });
}

function useRunUsage(
  job: OptimizationStatusResponse,
  pairIndex: number | null,
): { usage: RunUsage | null; error: boolean } {
  const [usage, setUsage] = useState<RunUsage | null>(null);
  const [error, setError] = useState(false);
  const running = ACTIVE_STATUSES.has(job.status);
  const settling = usage?.settling ?? false;
  const polling = running || settling;

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      getRunUsage(job.optimization_id, pairIndex)
        .then((next) => {
          if (cancelled) return;
          setUsage(next);
          setError(false);
        })
        .catch(() => {
          if (!cancelled) setError(true);
        });
    void load();
    const timer = polling
      ? window.setInterval(() => void load(), running ? LIVE_REFRESH_MS : SETTLE_POLL_MS)
      : undefined;
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // A status change refetches once more, so a finished run shows its final rows.
  }, [job.optimization_id, job.status, pairIndex, polling, running]);

  return { usage, error };
}

function Summary({
  job,
  usage,
  running,
  splitCost,
}: {
  job: OptimizationStatusResponse;
  usage: RunUsage;
  running: boolean;
  splitCost: boolean;
}) {
  const locale = getActiveIntlLocale();
  const budget = job.execution_budget ?? job.terminal_evidence?.execution_budget;
  const total = usageTotal(usage.rows);
  const budgetHit = isBudgetStop(job) || isBudgetPause(job);
  const spentLabel = running
    ? msg("usage_tab.summary.spent_so_far")
    : msg("usage_tab.summary.spent");
  const items: Array<[string, string, string?]> = [];
  if (budget) {
    items.push([
      msg("usage_tab.summary.limit"),
      budget.uncapped
        ? msg("submit.budget.uncapped_short")
        : formatBudgetUsd(String(budget.total_cents), locale),
      tip("usage_tab.summary.limit"),
    ]);
  }
  items.push([
    spentLabel,
    formatCentsUsd(total.chargedCents, locale),
    tip("usage_tab.summary.spent"),
  ]);
  if (splitCost && total.providerCents != null) {
    items.push([
      msg("usage_tab.provider"),
      formatCentsUsd(total.providerCents, locale),
      tip("usage_tab.provider"),
    ]);
  }
  if (budget) {
    items.push([
      msg("usage_tab.summary.reserved"),
      formatBudgetUsd(budget.reserved_cents, locale),
      tip("usage_tab.summary.reserved"),
    ]);
    items.push([
      msg("usage_tab.summary.available"),
      formatBudgetUsd(budget.available_cents, locale),
      tip("usage_tab.summary.available"),
    ]);
  }
  items.push([
    msg("usage_tab.summary.calls"),
    formatCount(total.calls),
    tip("usage_tab.summary.calls"),
  ]);
  items.push([
    msg("usage_tab.summary.tokens"),
    formatCount(total.inputTokens + total.outputTokens),
    tip("usage_tab.summary.tokens"),
  ]);
  return (
    <dl
      className={cn(
        "grid grid-cols-2 gap-3 rounded-xl border border-border/50 bg-card/40 p-4 text-sm sm:grid-cols-3 lg:grid-cols-7",
        budgetHit && "border-[#9a6a10]/40",
      )}
    >
      {items.map(([label, value, help]) => (
        <div key={label} className="min-w-0 space-y-1">
          <dt className="text-xs text-muted-foreground">
            {help ? <HelpTip text={help}>{label}</HelpTip> : label}
          </dt>
          <dd className="break-all font-medium tabular-nums" dir="ltr">
            {value}
          </dd>
        </div>
      ))}
      {budgetHit && (
        <p className="col-span-full text-xs text-[#9a6a10]">{msg("usage_tab.budget_stopped")}</p>
      )}
    </dl>
  );
}

/**
 * The run's Usage and cost tab: what it spent and what its models did, side by
 * side, for every optimizer. Rows come from the run's billing records, so they
 * add up to exactly what the run charged; sandbox compute and setup keep their
 * own rows under every grouping.
 */
export function UsageTab({
  job,
  pairIndex,
}: {
  job: OptimizationStatusResponse;
  pairIndex: number | null;
}) {
  const { usage, error } = useRunUsage(job, pairIndex);
  const [grouping, setGrouping] = useState<UsageGrouping>("role");
  useEffect(() => setGrouping(readGrouping()), []);
  const locale = getActiveIntlLocale();
  const running = ACTIVE_STATUSES.has(job.status);

  const rows = useMemo(() => usage?.rows ?? [], [usage]);
  const offered = useMemo(() => availableGroupings(rows), [rows]);
  const activeGrouping = offered.includes(grouping) ? grouping : "role";
  const groups = useMemo(() => groupUsage(rows, activeGrouping), [rows, activeGrouping]);
  const total = useMemo(() => usageTotal(rows), [rows]);
  const splitCost = hasProviderSpend(rows);
  const firstNonModel = groups.findIndex((g) => g.nonModel);

  if (!usage) {
    return error ? <EmptyState icon={Coins} title={msg("usage_tab.load_error")} /> : null;
  }

  const cost = (g: UsageGroup) =>
    g.unpriced && g.chargedCents === 0 ? (
      <HelpTip text={tip("usage_tab.not_priced")}>{msg("usage_tab.not_priced")}</HelpTip>
    ) : (
      formatCentsUsd(g.chargedCents, locale)
    );
  const provider = (g: UsageGroup) =>
    g.providerCents == null ? empty : formatCentsUsd(g.providerCents, locale);
  const empty = <span className="text-muted-foreground/50">{msg("common.empty")}</span>;
  const activity = (g: UsageGroup, value: string) => (g.nonModel ? empty : value);
  const costLabel = splitCost ? msg("usage_tab.charged") : msg("usage_tab.col.cost");

  return (
    <FadeIn>
      <div className="space-y-4">
        <Summary job={job} usage={usage} running={running} splitCost={splitCost} />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3 overflow-x-auto no-scrollbar">
            <div className="inline-flex items-center gap-1.5">
              <Stack className="size-3 text-foreground/35" aria-hidden="true" />
              <Segmented
                size="sm"
                label={msg("usage_tab.group.label")}
                value={activeGrouping}
                onChange={(next) => {
                  setGrouping(next);
                  writeGrouping(next);
                }}
                options={offered.map((g) => ({ value: g, label: msg(GROUPING_LABEL_KEYS[g]) }))}
              />
            </div>
            {running && <LiveMarker status="live" />}
          </div>
          <ExportTableMenu
            iconOnly
            disabled={groups.length === 0}
            getData={() => ({
              filename: `usage-${activeGrouping}-${job.optimization_id.slice(0, 8)}`,
              columns: [
                "name",
                "charged_usd",
                ...(splitCost ? ["provider_usd_estimate"] : []),
                "calls",
                "input_tokens",
                "output_tokens",
                "avg_response_ms",
              ],
              rows: groups.map((g) => ({
                name: groupLabel(g, activeGrouping),
                charged_usd: g.chargedCents / 100,
                provider_usd_estimate: g.providerCents == null ? "" : g.providerCents / 100,
                calls: g.calls,
                input_tokens: g.inputTokens,
                output_tokens: g.outputTokens,
                avg_response_ms: g.avgLatencyMs == null ? "" : Math.round(g.avgLatencyMs),
              })),
            })}
          />
        </div>

        {groups.length === 0 ? (
          <EmptyState
            icon={Coins}
            title={msg("usage_tab.empty_title")}
            description={msg("usage_tab.empty_body")}
          />
        ) : (
          <Card className="overflow-hidden py-0">
            <CardContent className="p-0">
              <Table className="no-copy-underline">
                <TableHeader>
                  <TableRow>
                    <TableHead className="ps-4">
                      <HelpTip text={tip(GROUPING_TIP_KEYS[activeGrouping])}>
                        {msg(GROUPING_LABEL_KEYS[activeGrouping])}
                      </HelpTip>
                    </TableHead>
                    <TableHead className="text-end">
                      <HelpTip text={tip(splitCost ? "usage_tab.charged" : "usage_tab.col.cost")}>
                        {costLabel}
                      </HelpTip>
                    </TableHead>
                    {splitCost && (
                      <TableHead className="text-end" collapse="sm">
                        <HelpTip text={tip("usage_tab.provider")}>
                          {msg("usage_tab.provider")}
                        </HelpTip>
                      </TableHead>
                    )}
                    <TableHead className="text-end">
                      <HelpTip text={tip("usage_tab.col.calls")}>
                        {msg("usage_tab.col.calls")}
                      </HelpTip>
                    </TableHead>
                    <TableHead className="text-end" collapse="md">
                      <HelpTip text={tip("usage_tab.col.input")}>
                        {msg("usage_tab.col.input")}
                      </HelpTip>
                    </TableHead>
                    <TableHead className="text-end" collapse="md">
                      <HelpTip text={tip("usage_tab.col.output")}>
                        {msg("usage_tab.col.output")}
                      </HelpTip>
                    </TableHead>
                    <TableHead className="pe-4 text-end" collapse="lg">
                      <HelpTip text={tip("usage_tab.col.latency")}>
                        {msg("usage_tab.col.latency")}
                      </HelpTip>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {groups.map((g, i) => {
                    const label = groupLabel(g, activeGrouping);
                    const rowTipKey: TooltipKey | undefined =
                      activeGrouping === "role" || g.nonModel
                        ? ROLE_TIP_KEYS[g.key]
                        : g.key === UNATTRIBUTED
                          ? "usage_tab.unattributed"
                          : activeGrouping === "stage"
                            ? STAGE_TIP_KEYS[g.key]
                            : undefined;
                    const roleTip = rowTipKey ? tip(rowTipKey) : null;
                    return (
                      <TableRow
                        key={`${g.nonModel ? "n" : "m"}:${g.key}`}
                        className={cn(i === firstNonModel && i > 0 && "border-t border-border")}
                      >
                        <TableCell className="max-w-[18rem] ps-4">
                          {i === firstNonModel && activeGrouping === "model" && (
                            <span className="mb-0.5 block text-[0.6875rem] text-muted-foreground">
                              {msg("usage_tab.not_model")}
                            </span>
                          )}
                          <span
                            className={cn(
                              "block truncate",
                              activeGrouping === "model" && !g.nonModel && "font-mono text-xs",
                            )}
                            dir="auto"
                          >
                            {roleTip ? <HelpTip text={roleTip}>{label}</HelpTip> : label}
                          </span>
                          <TableInline at="md">
                            {activity(g, formatCount(g.inputTokens + g.outputTokens))}
                          </TableInline>
                        </TableCell>
                        <TableCell className="text-end font-medium tabular-nums" dir="ltr">
                          {cost(g)}
                        </TableCell>
                        {splitCost && (
                          <TableCell className="text-end tabular-nums" dir="ltr" collapse="sm">
                            {provider(g)}
                          </TableCell>
                        )}
                        <TableCell className="text-end tabular-nums">
                          {activity(g, formatCount(g.calls))}
                        </TableCell>
                        <TableCell className="text-end tabular-nums" collapse="md">
                          {activity(g, formatCount(g.inputTokens))}
                        </TableCell>
                        <TableCell className="text-end tabular-nums" collapse="md">
                          {activity(g, formatCount(g.outputTokens))}
                        </TableCell>
                        <TableCell className="pe-4 text-end tabular-nums" collapse="lg">
                          {activity(g, formatLatency(g.avgLatencyMs))}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  <TableRow className="border-t border-border bg-muted/30 font-semibold hover:bg-muted/30">
                    <TableCell className="ps-4">
                      <HelpTip text={tip("usage_tab.total")}>{msg("usage_tab.total")}</HelpTip>
                      {running && (
                        <span className="ms-1.5 text-xs font-normal text-muted-foreground">
                          {msg("usage_tab.so_far")}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-end tabular-nums" dir="ltr">
                      {formatCentsUsd(total.chargedCents, locale)}
                    </TableCell>
                    {splitCost && (
                      <TableCell className="text-end tabular-nums" dir="ltr" collapse="sm">
                        {provider(total)}
                      </TableCell>
                    )}
                    <TableCell className="text-end tabular-nums">
                      {formatCount(total.calls)}
                    </TableCell>
                    <TableCell className="text-end tabular-nums" collapse="md">
                      {formatCount(total.inputTokens)}
                    </TableCell>
                    <TableCell className="text-end tabular-nums" collapse="md">
                      {formatCount(total.outputTokens)}
                    </TableCell>
                    <TableCell className="pe-4 text-end tabular-nums" collapse="lg">
                      {formatLatency(total.avgLatencyMs)}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
        {usage.settling && !running && (
          <p className="text-xs text-muted-foreground">{msg("usage_tab.settling")}</p>
        )}
      </div>
    </FadeIn>
  );
}
