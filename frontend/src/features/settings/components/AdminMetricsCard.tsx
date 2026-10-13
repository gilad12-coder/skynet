"use client";

import * as React from "react";

import { ApiError, getNorthStarMetrics, type NorthStarMetricsResponse } from "@/shared/lib/api";
import { msg } from "@/shared/lib/messages";
import { getActiveIntlLocale } from "@/shared/lib/runtime-locale";
import { EmptyState } from "@/shared/ui/empty-state";
import { TrendUp } from "@/shared/ui/icons";
import { InlineErrorRow } from "@/shared/ui/inline-error-row";
import { LoadingState } from "@/shared/ui/loading-state";
import { RetryIconButton } from "@/shared/ui/retry-icon-button";

/** Signup weeks shown in the table. */
export const METRIC_WEEKS = 8;

export interface NorthStarRow {
  week: string;
  signups: number;
  firstLifts: number;
  newLifted: number;
  returningLifted: number;
  inUse: number;
}

export type AdminMetricsState =
  | { kind: "loading" }
  | { kind: "forbidden" }
  | { kind: "error" }
  | { kind: "ready"; data: NorthStarMetricsResponse };

/**
 * Join the three series into one row per week, newest first. The backend
 * zero-fills every series to the same weeks, but the join goes by week so a
 * shorter series never shifts numbers into the wrong row.
 */
export function northStarRows(data: NorthStarMetricsResponse): NorthStarRow[] {
  const lifted = new Map(data.lifted_users.map((row) => [row.week, row]));
  const inUse = new Map(data.lifted_in_use.map((row) => [row.week, row.users_in_use]));
  return data.first_lifts.slice(0, METRIC_WEEKS).map((row) => ({
    week: row.signup_week,
    signups: row.signups,
    firstLifts: row.first_lifts,
    newLifted: lifted.get(row.signup_week)?.new_lifted ?? 0,
    returningLifted: lifted.get(row.signup_week)?.returning_lifted ?? 0,
    inUse: inUse.get(row.signup_week) ?? 0,
  }));
}

/** A 403 means the viewer isn't an admin, so the card hides instead of erroring. */
export function stateFromError(err: unknown): AdminMetricsState {
  return err instanceof ApiError && err.status === 403 ? { kind: "forbidden" } : { kind: "error" };
}

/** Week starts are calendar dates, so format them in UTC to avoid a one-day shift. */
function formatWeek(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return date.toLocaleDateString(getActiveIntlLocale(), {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function formatCount(value: number): string {
  return new Intl.NumberFormat(getActiveIntlLocale()).format(value);
}

const COLUMNS = [
  ["week", "settings.admin.metrics.col.week"],
  ["signups", "settings.admin.metrics.col.signups"],
  ["firstLifts", "settings.admin.metrics.col.first_lifts"],
  ["newLifted", "settings.admin.metrics.col.new_lifted"],
  ["returningLifted", "settings.admin.metrics.col.returning_lifted"],
  ["inUse", "settings.admin.metrics.col.in_use"],
] as const;

/** Presentational card body for a given load state; `null` when the viewer isn't an admin. */
export function AdminMetricsView({
  state,
  onRetry,
}: {
  state: AdminMetricsState;
  onRetry?: () => void;
}) {
  if (state.kind === "forbidden") return null;
  const rows = state.kind === "ready" ? northStarRows(state.data) : [];
  const latest = rows[0];
  const hasSignups = rows.some((row) => row.signups > 0);

  return (
    <section
      aria-labelledby="admin-metrics-title"
      className="space-y-3 rounded-lg border border-border/60 p-4"
    >
      <header className="flex items-start gap-3">
        <TrendUp className="size-4 mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0">
          <h3 id="admin-metrics-title" className="text-sm font-medium">
            {msg("settings.admin.metrics.title")}
          </h3>
          <p className="text-xs text-muted-foreground">
            {msg("settings.admin.metrics.description")}
          </p>
        </div>
      </header>

      {state.kind === "loading" && <LoadingState className="py-6" />}

      {state.kind === "error" && (
        <InlineErrorRow
          message={msg("settings.admin.metrics.load_failed")}
          action={
            onRetry ? (
              <RetryIconButton label={msg("settings.admin.metrics.retry")} onClick={onRetry} />
            ) : undefined
          }
        />
      )}

      {state.kind === "ready" && !hasSignups && (
        <EmptyState
          variant="compact"
          icon={TrendUp}
          title={msg("settings.admin.metrics.empty")}
          description={msg("settings.admin.metrics.empty_description")}
        />
      )}

      {state.kind === "ready" && hasSignups && latest && (
        <>
          <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
            <div data-testid="admin-metrics-headline">
              <p className="text-2xl font-semibold tabular-nums">
                {formatCount(latest.firstLifts)}
              </p>
              <p className="text-xs text-muted-foreground">
                {msg("settings.admin.metrics.headline_detail", {
                  signups: formatCount(latest.signups),
                })}
              </p>
            </div>
            <div>
              <p className="text-2xl font-semibold tabular-nums">{formatCount(latest.inUse)}</p>
              <p className="text-xs text-muted-foreground">
                {msg("settings.admin.metrics.in_use")}
              </p>
              <p className="text-[0.6875rem] text-muted-foreground/80">
                {msg("settings.admin.metrics.in_use_detail")}
              </p>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border/60 text-muted-foreground">
                  {COLUMNS.map(([key, label]) => (
                    <th key={key} scope="col" className="px-2 py-1.5 text-start font-medium">
                      {msg(label)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.week} className="border-b border-border/30 last:border-b-0">
                    {COLUMNS.map(([key]) => (
                      <td key={key} className="px-2 py-1.5 text-start tabular-nums">
                        {key === "week" ? formatWeek(row.week) : formatCount(row[key])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

/** Admin-tab card: First Lifts per week, new/returning lifted users and lifted-in-use. */
export function AdminMetricsCard({ enabled = true }: { enabled?: boolean }) {
  const [state, setState] = React.useState<AdminMetricsState>({ kind: "loading" });

  const load = React.useCallback(async () => {
    setState({ kind: "loading" });
    try {
      setState({ kind: "ready", data: await getNorthStarMetrics(METRIC_WEEKS) });
    } catch (err) {
      setState(stateFromError(err));
    }
  }, []);

  React.useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);

  return <AdminMetricsView state={state} onRetry={() => void load()} />;
}
