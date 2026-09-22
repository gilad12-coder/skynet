"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartEmptyState } from "@/shared/charts/chart-utils";
import { ChartTable } from "@/shared/charts/chart-table";
import { useLiteMode } from "@/features/settings";
import { getStatusLabel } from "@/shared/constants/job-status";
import type { DashboardAnalyticsGranularity } from "@/shared/lib/api";
import { msg } from "@/shared/lib/messages";
import { getActiveDir } from "@/shared/lib/runtime-locale";
import { STATUS_COLORS } from "../constants";
import type { HistogramBar, TimelinePoint } from "../lib/transform-chart-data";

const AXIS_TICK = { fontSize: 10 };
const GRID_CLASS = "stroke-muted";
const CURSOR_FILL = { fill: "var(--color-chart-5)", fillOpacity: 0.12 };

function formatPoints(value: number | null | undefined): string {
  if (value == null) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

type TooltipRow = { label: string; value: string; color?: string };

function TooltipCard({ title, rows }: { title: string; rows: TooltipRow[] }) {
  return (
    <div
      className="rounded-xl border border-border/60 bg-background/95 p-3 text-sm shadow-lg backdrop-blur-sm"
      dir={getActiveDir()}
    >
      <p className="mb-2 font-semibold text-foreground">{title}</p>
      <div className="space-y-1">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center gap-2 text-muted-foreground">
            {row.color && (
              <span
                className="size-2.5 shrink-0 rounded-full ring-1 ring-black/5"
                style={{ backgroundColor: row.color }}
              />
            )}
            <span className="text-xs">{row.label}:</span>
            <span className="ms-auto font-mono font-semibold tabular-nums text-foreground" dir="ltr">
              {row.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Fixed-edge histogram (improvement, run time or dataset size). The buckets
 * are computed server-side, so the chart has the same handful of bars whether
 * the user has three runs or three thousand. When `withAverage` is set (the
 * dataset-size breakdown) a line traces the mean improvement per bucket so the
 * "does more data help?" question is answered on the same axis.
 */
export function RangeHistogram({
  data,
  unitLabel,
  withAverage = false,
  emptyMessage,
}: {
  data: HistogramBar[];
  unitLabel: string;
  withAverage?: boolean;
  emptyMessage?: string;
}) {
  const lite = useLiteMode();
  const runsLabel = msg("dashboard.analytics.runs");
  const avgLabel = msg("auto.features.dashboard.components.analyticstab.8");

  if (data.length === 0) return <ChartEmptyState message={emptyMessage} />;

  if (lite) {
    return (
      <div className="h-[240px]">
        <ChartTable
          rows={data}
          columns={[
            {
              key: "label",
              label: `${msg("dashboard.analytics.col_range")} (${unitLabel})`,
              format: (value) => <span dir="ltr">{String(value)}</span>,
            },
            { key: "count", label: runsLabel, align: "end" },
            ...(withAverage
              ? [
                  {
                    key: "avgImprovement" as const,
                    label: avgLabel,
                    align: "end" as const,
                    format: (value: unknown) => formatPoints(value as number | null),
                  },
                ]
              : []),
          ]}
        />
      </div>
    );
  }

  const tooltip = (
    <Tooltip
      cursor={CURSOR_FILL}
      content={({ active, payload }) => {
        const row = payload?.[0]?.payload as HistogramBar | undefined;
        if (!active || !row) return null;
        const rows: TooltipRow[] = [
          { label: runsLabel, value: String(row.count), color: "var(--color-chart-2)" },
        ];
        if (withAverage) {
          rows.push({
            label: avgLabel,
            value: formatPoints(row.avgImprovement),
            color: "var(--color-chart-4)",
          });
        }
        return <TooltipCard title={`${row.label} ${unitLabel}`} rows={rows} />;
      }}
    />
  );

  const axes = (
    <>
      <CartesianGrid vertical={false} strokeDasharray="3 3" className={GRID_CLASS} />
      <XAxis
        dataKey="label"
        tickLine={false}
        axisLine={false}
        tick={AXIS_TICK}
        interval={0}
        className="fill-muted-foreground"
        label={{ value: unitLabel, position: "insideBottom", offset: -6, fontSize: 10 }}
      />
      <YAxis
        yAxisId="count"
        tickLine={false}
        axisLine={false}
        tick={AXIS_TICK}
        allowDecimals={false}
        width={32}
        className="fill-muted-foreground"
      />
    </>
  );

  return (
    <div className="h-[240px] min-w-0" dir="ltr">
      <ResponsiveContainer width="100%" height="100%">
        {withAverage ? (
          <ComposedChart data={data} margin={{ left: 0, right: 8, top: 10, bottom: 18 }}>
            {axes}
            <YAxis
              yAxisId="avg"
              orientation="right"
              tickLine={false}
              axisLine={false}
              tick={AXIS_TICK}
              width={40}
              tickFormatter={(v: number) => `${v}%`}
              className="fill-muted-foreground"
            />
            {tooltip}
            <Bar
              yAxisId="count"
              dataKey="count"
              name={runsLabel}
              fill="var(--color-chart-2)"
              radius={[4, 4, 0, 0]}
              maxBarSize={48}
              animationDuration={300}
            />
            <Line
              yAxisId="avg"
              type="monotone"
              dataKey="avgImprovement"
              name={avgLabel}
              stroke="var(--color-chart-4)"
              strokeWidth={2}
              dot={{ r: 3, strokeWidth: 0, fill: "var(--color-chart-4)" }}
              connectNulls={false}
              animationDuration={300}
            />
          </ComposedChart>
        ) : (
          <BarChart data={data} margin={{ left: 0, right: 8, top: 10, bottom: 18 }}>
            {axes}
            {tooltip}
            <Bar
              yAxisId="count"
              dataKey="count"
              name={runsLabel}
              fill="var(--color-chart-2)"
              radius={[4, 4, 0, 0]}
              maxBarSize={48}
              animationDuration={300}
            />
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

/**
 * Submissions over time as stacked success/failed/other bars. Bucket width is
 * chosen server-side (day, week or month) from the span of the filtered runs,
 * and the axis thins its ticks, so a two-year history stays legible. Clicking
 * a bar narrows the dashboard to that day; wider buckets are not clickable
 * because the `date` filter is a single calendar day.
 */
export function StackedTimeline({
  data,
  granularity,
  onDayClick,
}: {
  data: TimelinePoint[];
  granularity: DashboardAnalyticsGranularity;
  onDayClick?: (date: string) => void;
}) {
  const lite = useLiteMode();
  const successLabel = getStatusLabel("success");
  const failedLabel = getStatusLabel("failed");
  const otherLabel = msg("dashboard.analytics.legend_other");
  const totalLabel = msg("dashboard.analytics.runs");
  const clickable = granularity === "day" && onDayClick != null;

  if (data.length === 0) return <ChartEmptyState />;

  if (lite) {
    return (
      <div className="h-[240px]">
        <ChartTable
          rows={data}
          columns={[
            { key: "label", label: msg("dashboard.analytics.col_date") },
            { key: "success", label: successLabel, align: "end" },
            { key: "failed", label: failedLabel, align: "end" },
            { key: "other", label: otherLabel, align: "end" },
            { key: "total", label: totalLabel, align: "end" },
          ]}
          onRowClick={clickable ? (row) => onDayClick(row.date) : undefined}
        />
      </div>
    );
  }

  const handleClick = clickable
    ? (_: unknown, index: number) => {
        const point = data[index];
        if (point) onDayClick(point.date);
      }
    : undefined;

  const series = [
    { key: "success", label: successLabel, fill: STATUS_COLORS.success },
    { key: "failed", label: failedLabel, fill: STATUS_COLORS.failed },
    { key: "other", label: otherLabel, fill: "var(--color-chart-4)" },
  ] as const;

  return (
    <div className="h-[220px] min-w-0" dir="ltr">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ left: 0, right: 8, top: 10, bottom: 4 }} barCategoryGap="20%">
          <CartesianGrid vertical={false} strokeDasharray="3 3" className={GRID_CLASS} />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tick={AXIS_TICK}
            minTickGap={28}
            interval="preserveStartEnd"
            className="fill-muted-foreground"
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            tick={AXIS_TICK}
            allowDecimals={false}
            width={32}
            className="fill-muted-foreground"
          />
          <Tooltip
            cursor={CURSOR_FILL}
            content={({ active, payload }) => {
              const point = payload?.[0]?.payload as TimelinePoint | undefined;
              if (!active || !point) return null;
              return (
                <TooltipCard
                  title={point.label}
                  rows={[
                    ...series
                      .filter((s) => point[s.key] > 0)
                      .map((s) => ({ label: s.label, value: String(point[s.key]), color: s.fill })),
                    { label: totalLabel, value: String(point.total) },
                  ]}
                />
              );
            }}
          />
          {series.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              name={s.label}
              stackId="runs"
              fill={s.fill}
              radius={i === series.length - 1 ? [3, 3, 0, 0] : 0}
              maxBarSize={28}
              animationDuration={300}
              cursor={clickable ? "pointer" : "default"}
              onClick={handleClick}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
