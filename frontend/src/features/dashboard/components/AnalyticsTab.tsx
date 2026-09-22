import { memo } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import dynamic from "next/dynamic";
import { AnimatePresence, motion } from "framer-motion";
import { AnimatedNumber, StaggerContainer, StaggerItem } from "@/shared/ui/motion";
import { HelpTip } from "@/shared/ui/help-tip";
import { formatElapsed, modelDisplayName } from "@/shared/lib";
import type { DashboardAnalytics, DashboardAnalyticsJob } from "@/shared/lib/api";
import { formatMsg, msg } from "@/shared/lib/messages";
import { getActiveIntlLocale } from "@/shared/lib/runtime-locale";
import { tip } from "@/shared/lib/tooltips";
import { TERMS } from "@/shared/lib/terms";
import { cn } from "@/shared/lib/utils";
import { STATUS_COLORS } from "../constants";
import { AnalyticsEmpty } from "./AnalyticsEmpty";
import { AnalyticsFilterChips } from "./AnalyticsFilterChips";
import { AnalyticsSection } from "./AnalyticsSection";
import { AnalyticsTabSkeleton } from "./AnalyticsTabSkeleton";
import type { ChartData, OptimizerRow, ShareBar } from "../lib/transform-chart-data";
import type { AnalyticsRange, UseAnalyticsFiltersReturn } from "../hooks/use-analytics-filters";

const chartFallback = (height: number) => (
  <div className="flex items-center justify-center" style={{ height }}>
    <span className="text-sm text-muted-foreground">
      {msg("auto.features.dashboard.components.analyticstab.1")}
    </span>
  </div>
);

const RangeHistogram = dynamic(
  () => import("./AnalyticsCharts").then((m) => m.RangeHistogram),
  { ssr: false, loading: () => chartFallback(240) },
);
const StackedTimeline = dynamic(
  () => import("./AnalyticsCharts").then((m) => m.StackedTimeline),
  { ssr: false, loading: () => chartFallback(220) },
);
const SharingBreakdown = dynamic(() => import("./UsageCharts"), {
  ssr: false,
  loading: () => <div className="h-[260px]" />,
});

type AnalyticsTabProps = {
  analyticsLoading: boolean;
  analyticsData: DashboardAnalytics | null;
  chartData: ChartData;
  filters: UseAnalyticsFiltersReturn;
  sessionUser: string;
  onOpenJob: (optimizationId: string) => void;
};

type KpiAccent = "default" | "success" | "warning" | "danger";

const KPI_DOT: Record<KpiAccent, string> = {
  default: "bg-foreground/25",
  success: "bg-emerald-500",
  warning: "bg-[var(--warning)]",
  danger: "bg-red-500",
};

const KPI_TEXT: Record<KpiAccent, string> = {
  default: "text-foreground",
  success: "text-emerald-600",
  warning: "text-[var(--warning)]",
  danger: "text-red-600",
};

const RANGE_OPTIONS: readonly AnalyticsRange[] = ["7d", "30d", "90d", "all"];

const PILL_TRANSITION = { type: "tween", duration: 0.16, ease: [0.22, 1, 0.36, 1] } as const;

function KpiCard({
  label,
  value,
  detail,
  accent,
  valueDir,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  accent: KpiAccent;
  valueDir?: "ltr" | "rtl";
}) {
  return (
    <div className="flex h-full min-w-0 flex-[1_1_11rem] flex-col gap-4 rounded-2xl border border-border/40 bg-card/60 p-5 transition-colors duration-300 hover:border-border/70 sm:p-6 xl:flex-[1_1_8rem]">
      <div className="flex items-center gap-2">
        <span className={`size-1.5 rounded-full ${KPI_DOT[accent]}`} aria-hidden />
        <p className="text-[0.625rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">
          {label}
        </p>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-2">
        <p
          dir={valueDir}
          className={`text-center text-[2.5rem] font-bold leading-[0.9] tracking-tight tabular-nums sm:text-[3rem] ${KPI_TEXT[accent]}`}
        >
          {value}
        </p>
        {detail && (
          <p className="text-center text-[0.6875rem] tabular-nums text-muted-foreground">{detail}</p>
        )}
      </div>
    </div>
  );
}

function activateOnKey(e: KeyboardEvent, action: () => void) {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    action();
  }
}

function pointsValue(value: number | null): ReactNode {
  if (value == null) return "—";
  return (
    <AnimatedNumber
      value={parseFloat(value.toFixed(1))}
      decimals={1}
      prefix={value > 0 ? "+" : ""}
      suffix="%"
    />
  );
}

function pointsText(value: number | null | undefined): string {
  if (value == null) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function pointsAccent(value: number | null): KpiAccent {
  if (value == null || value === 0) return "default";
  return value > 0 ? "success" : "danger";
}

/** Sliding segmented control for the date range, matching the wallet usage tab. */
function RangeControl({
  value,
  onChange,
}: {
  value: AnalyticsRange;
  onChange: (next: AnalyticsRange) => void;
}) {
  return (
    <div
      role="group"
      aria-label={msg("usage.range.label")}
      className="flex items-center gap-0.5 rounded-lg bg-muted/60 p-0.5"
    >
      {RANGE_OPTIONS.map((option) => {
        const active = option === value;
        return (
          <button
            key={option}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option)}
            className={cn(
              "relative min-h-[44px] cursor-pointer rounded-md px-2.5 py-1 text-xs font-medium transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C8A882]/45 sm:min-h-0 [@media(hover:none)_and_(pointer:coarse)]:min-h-[44px]",
              active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {active && (
              <motion.span
                layoutId="analytics-range-pill"
                className="absolute inset-0 rounded-md bg-background shadow-[0_1px_2px_oklch(0.25_0.04_45/.12)]"
                transition={PILL_TRANSITION}
                aria-hidden="true"
              />
            )}
            <span className="relative z-10">{msg(`usage.range.${option}`)}</span>
          </button>
        );
      })}
    </div>
  );
}

function PanelHeading({ children }: { children: ReactNode }) {
  return (
    <p className="mb-3 text-[0.6875rem] font-semibold uppercase tracking-widest text-muted-foreground">
      {children}
    </p>
  );
}

/** Horizontal share bars (status, type, module); the bar is a share of all runs. */
function ShareBars({
  bars,
  color,
  onSelect,
}: {
  bars: ShareBar[];
  color?: (bar: ShareBar) => string;
  onSelect?: (key: string) => void;
}) {
  return (
    <div className="space-y-2.5">
      {bars.map((bar) => {
        const fill = color?.(bar) ?? "var(--color-chart-3)";
        const interactive = onSelect != null;
        return (
          <div
            key={bar.key}
            role={interactive ? "button" : undefined}
            tabIndex={interactive ? 0 : undefined}
            className={cn(
              "space-y-1.5 rounded-md py-1",
              interactive &&
                "min-h-[44px] cursor-pointer transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 lg:min-h-0",
            )}
            onClick={interactive ? () => onSelect(bar.key) : undefined}
            onKeyDown={interactive ? (e) => activateOnKey(e, () => onSelect(bar.key)) : undefined}
          >
            <div className="flex items-center justify-between gap-3 text-[0.8125rem]">
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className="size-2.5 shrink-0 rounded-full ring-1 ring-black/5"
                  style={{ backgroundColor: fill }}
                />
                <span className="truncate" title={bar.name}>
                  {bar.name}
                </span>
              </span>
              <span className="shrink-0 tabular-nums font-semibold">
                {bar.value}
                <span className="ms-1.5 text-[0.6875rem] font-normal text-muted-foreground">
                  {Math.round(bar.pct)}%
                </span>
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted/60">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{ width: `${bar.pct}%`, backgroundColor: fill }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

const TH = "px-3 py-2 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground";
const TD = "px-3 py-2.5 tabular-nums";
const ROW_BUTTON =
  "cursor-pointer border-t border-border/60 transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:bg-accent/50";

function OptimizerTable({
  rows,
  onSelect,
}: {
  rows: OptimizerRow[];
  onSelect: (name: string) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border/60">
      <table className="w-full min-w-[34rem] border-collapse text-sm">
        <thead className="bg-muted/50">
          <tr>
            <th className={`${TH} text-start`}>{TERMS.optimizer}</th>
            <th className={`${TH} text-end`}>{msg("dashboard.analytics.runs")}</th>
            <th className={`${TH} text-end`}>
              {msg("auto.features.dashboard.components.analyticstab.4")}
            </th>
            <th className={`${TH} text-end`}>
              {msg("auto.features.dashboard.components.analyticstab.8")}
            </th>
            <th className={`${TH} text-end`}>
              {msg("auto.features.dashboard.components.analyticstab.11")}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.name}
              tabIndex={0}
              className={ROW_BUTTON}
              onClick={() => onSelect(row.name)}
              onKeyDown={(e) => activateOnKey(e, () => onSelect(row.name))}
            >
              <td className={`${TD} min-w-[12rem]`}>
                <div className="flex flex-col gap-1.5">
                  <span className="font-medium" dir="ltr">
                    {row.name}
                  </span>
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted/60" dir="ltr">
                    <div
                      className="h-full rounded-full bg-[var(--color-chart-2)] transition-all duration-500"
                      style={{ width: `${row.share}%` }}
                    />
                  </div>
                </div>
              </td>
              <td className={`${TD} text-end font-semibold`}>{row.count}</td>
              <td className={`${TD} text-end`}>{Math.round(row.successRate)}%</td>
              <td
                className={cn(
                  `${TD} text-end font-medium`,
                  row.avgImprovement != null && row.avgImprovement > 0 && "text-emerald-600",
                  row.avgImprovement != null && row.avgImprovement < 0 && "text-red-600",
                )}
                dir="ltr"
              >
                {pointsText(row.avgImprovement)}
              </td>
              <td className={`${TD} text-end`} dir="ltr">
                {row.avgRuntimeMinutes == null ? "—" : formatElapsed(row.avgRuntimeMinutes * 60)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Leaderboard({
  jobs,
  onOpenJob,
}: {
  jobs: DashboardAnalyticsJob[];
  onOpenJob: (optimizationId: string) => void;
}) {
  const locale = getActiveIntlLocale();
  return (
    <div className="overflow-x-auto rounded-lg border border-border/60">
      <table className="w-full min-w-[40rem] border-collapse text-sm">
        <thead className="bg-muted/50">
          <tr>
            <th className={`${TH} w-8 text-start`}>#</th>
            <th className={`${TH} text-start`}>{msg("dashboard.analytics.col_name")}</th>
            <th className={`${TH} text-start`}>{TERMS.optimizer}</th>
            <th className={`${TH} text-start`}>{TERMS.model}</th>
            <th className={`${TH} text-end`}>{TERMS.scoreImprovement}</th>
            <th className={`${TH} text-end`}>
              {msg("auto.features.dashboard.components.analyticstab.11")}
            </th>
            <th className={`${TH} text-end`}>{msg("dashboard.analytics.col_date")}</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job, i) => (
            <tr
              key={job.optimization_id}
              tabIndex={0}
              aria-label={msg("dashboard.analytics.open_job")}
              className={ROW_BUTTON}
              onClick={() => onOpenJob(job.optimization_id)}
              onKeyDown={(e) => activateOnKey(e, () => onOpenJob(job.optimization_id))}
            >
              <td className={`${TD} text-muted-foreground/70`}>{i + 1}</td>
              <td className={`${TD} max-w-[16rem] truncate font-medium`} title={job.name ?? undefined}>
                {job.name || <span dir="ltr">{job.optimization_id.slice(0, 8)}…</span>}
              </td>
              <td className={TD} dir="ltr">
                {job.optimizer_name ?? "—"}
              </td>
              <td className={`${TD} max-w-[12rem] truncate font-mono text-xs`} dir="ltr" title={job.model_name ?? undefined}>
                {job.model_name ? modelDisplayName(job.model_name) : "—"}
              </td>
              <td className={`${TD} text-end font-semibold text-emerald-600`} dir="ltr">
                {pointsText(improvementPoints(job.metric_improvement))}
              </td>
              <td className={`${TD} text-end`} dir="ltr">
                {job.elapsed_seconds == null ? "—" : formatElapsed(job.elapsed_seconds)}
              </td>
              <td className={`${TD} text-end whitespace-nowrap`}>
                {job.created_at
                  ? new Date(job.created_at).toLocaleDateString(locale, {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })
                  : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Leaderboard rows carry the raw metric delta; ratio-scale metrics (|delta| <= 1)
// are shown in percentage points like every other improvement figure here.
function improvementPoints(delta: number | null | undefined): number | null {
  if (delta == null) return null;
  return Math.abs(delta) <= 1 ? delta * 100 : delta;
}

// Rank-shaded ramp for the model list: the most-used model is darkest and
// lighter steps follow, so the list reads as a ranking. Clamps past rank 5.
const MODEL_RAMP = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
];

function AnalyticsTabImpl({
  analyticsLoading,
  analyticsData,
  chartData,
  filters,
  sessionUser,
  onOpenJob,
}: AnalyticsTabProps) {
  const {
    range,
    optimizer,
    model,
    status,
    date,
    owner,
    access,
    setRange,
    setOptimizer,
    setModel,
    setStatus,
    setDate,
    setOwner,
    setAccess,
  } = filters;

  const showOwners = chartData.ownerUsage.length > 1 || Boolean(owner);
  const showAccess = chartData.accessUsage.length > 1 || Boolean(access);

  if (analyticsLoading && analyticsData === null) {
    return <AnalyticsTabSkeleton />;
  }

  const hasFilters = Boolean(
    date ||
      owner ||
      access ||
      range !== "all" ||
      optimizer !== "all" ||
      model !== "all" ||
      status !== "all",
  );

  const toolbar = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <RangeControl value={range} onChange={setRange} />
      <AnalyticsFilterChips filters={filters} sessionUser={sessionUser} />
    </div>
  );

  if ((analyticsData?.filtered_total ?? 0) === 0) {
    if (hasFilters) {
      return (
        <div data-tutorial="analytics-content" className="space-y-6">
          {toolbar}
          <AnalyticsEmpty
            variant="no-results"
            onClearFilters={() => {
              setRange("all");
              setOptimizer("all");
              setModel("all");
              setStatus("all");
              setDate(null);
              setOwner(null);
              setAccess(null);
            }}
          />
        </div>
      );
    }
    return <AnalyticsEmpty variant="no-data" />;
  }

  const kpis = chartData.kpis;
  const granularityLabel = msg(`dashboard.analytics.timeline_by_${chartData.timelineGranularity}`);
  const noSuccessMessage = msg("dashboard.analytics.no_successful_runs");

  return (
    <div data-tutorial="analytics-content" className="space-y-6">
      {toolbar}

      {chartData.truncated && (
        <p className="rounded-lg border border-[var(--warning)]/30 bg-[var(--warning)]/10 px-3 py-2 text-xs text-foreground/80">
          {msg("dashboard.analytics.truncated")}
        </p>
      )}

      <AnimatePresence mode="wait">
        <motion.div
          key={`${range}-${optimizer}-${model}-${status}-${date ?? "all"}-${owner ?? "all"}-${access ?? "all"}`}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.3, ease: [0.2, 0.8, 0.2, 1] }}
        >
          <StaggerContainer className="space-y-6" staggerDelay={0.03}>
            {kpis && (
              <StaggerItem>
                <div data-tutorial="dashboard-stats" className="flex flex-wrap gap-3 sm:gap-4">
                  <KpiCard
                    label={msg("dashboard.analytics.kpi_total")}
                    accent="default"
                    value={<AnimatedNumber value={kpis.total} />}
                    detail={
                      kpis.runningCount > 0
                        ? formatMsg("dashboard.analytics.kpi_running_detail", {
                            p1: kpis.runningCount,
                          })
                        : undefined
                    }
                  />
                  <KpiCard
                    label={msg("auto.features.dashboard.components.analyticstab.4")}
                    accent="default"
                    value={<AnimatedNumber value={Math.round(kpis.successRate)} suffix="%" />}
                    detail={formatMsg("dashboard.analytics.kpi_success_detail", {
                      p1: kpis.successCount,
                      p2: kpis.terminalCount,
                    })}
                  />
                  <KpiCard
                    label={msg("auto.features.dashboard.components.analyticstab.8")}
                    accent={pointsAccent(kpis.avgImprovement)}
                    value={pointsValue(kpis.avgImprovement)}
                    detail={
                      kpis.medianImprovement != null
                        ? formatMsg("dashboard.analytics.kpi_median_detail", {
                            p1: pointsText(kpis.medianImprovement),
                          })
                        : undefined
                    }
                  />
                  <KpiCard
                    label={msg("auto.features.dashboard.components.analyticstab.11")}
                    accent="default"
                    valueDir="ltr"
                    value={
                      kpis.avgRuntimeSeconds == null ? "—" : formatElapsed(kpis.avgRuntimeSeconds)
                    }
                  />
                  <KpiCard
                    label={msg("auto.features.dashboard.components.analyticstab.15")}
                    accent={kpis.bestImprovement == null ? "default" : "warning"}
                    value={pointsValue(kpis.bestImprovement)}
                  />
                </div>
              </StaggerItem>
            )}

            <StaggerItem>
              <AnalyticsSection
                title={
                  <HelpTip text={tip("analytics.improvement_histogram")}>
                    {msg("dashboard.analytics.section_distributions")}
                  </HelpTip>
                }
                defaultOpen={true}
                className="border-border/60"
              >
                <div className="grid gap-6 md:grid-cols-2">
                  <div className="min-w-0">
                    <PanelHeading>{msg("dashboard.analytics.improvement_histogram")}</PanelHeading>
                    <RangeHistogram
                      data={chartData.improvementHistogram}
                      unitLabel={msg("dashboard.analytics.axis_points")}
                      emptyMessage={noSuccessMessage}
                    />
                  </div>
                  <div className="min-w-0">
                    <PanelHeading>
                      <HelpTip text={tip("analytics.runtime_histogram")}>
                        {msg("auto.features.dashboard.components.analyticstab.26")}
                      </HelpTip>
                    </PanelHeading>
                    <RangeHistogram
                      data={chartData.runtimeHistogram}
                      unitLabel={msg("dashboard.analytics.axis_minutes")}
                    />
                  </div>
                </div>
                <div className="mt-6 min-w-0">
                  <PanelHeading>
                    <HelpTip text={tip("analytics.dataset_buckets")}>
                      {msg("auto.features.dashboard.components.analyticstab.28")}
                      {TERMS.dataset}
                      {msg("auto.features.dashboard.components.analyticstab.29")}
                    </HelpTip>
                  </PanelHeading>
                  <RangeHistogram
                    data={chartData.datasetBuckets}
                    unitLabel={TERMS.rowPlural}
                    withAverage
                  />
                </div>
              </AnalyticsSection>
            </StaggerItem>

            <StaggerItem>
              <AnalyticsSection
                title={
                  <HelpTip text={tip("analytics.submissions_per_day")}>
                    {msg("auto.features.dashboard.components.analyticstab.30")}
                    <span className="ms-2 text-xs font-normal text-muted-foreground">
                      {granularityLabel}
                    </span>
                  </HelpTip>
                }
                defaultOpen={true}
                className="border-border/60"
              >
                <StackedTimeline
                  data={chartData.timeline}
                  granularity={chartData.timelineGranularity}
                  onDayClick={setDate}
                />
              </AnalyticsSection>
            </StaggerItem>

            {chartData.optimizerStats.length > 0 && (
              <StaggerItem>
                <AnalyticsSection
                  title={
                    <HelpTip text={tip("analytics.optimizer_comparison")}>
                      {msg("dashboard.analytics.optimizer_comparison")}
                    </HelpTip>
                  }
                  defaultOpen={true}
                  className="border-border/60"
                >
                  <OptimizerTable rows={chartData.optimizerStats} onSelect={setOptimizer} />
                </AnalyticsSection>
              </StaggerItem>
            )}

            <StaggerItem>
              <AnalyticsSection
                title={msg("dashboard.analytics.section_breakdown")}
                defaultOpen={true}
                className="border-border/60"
              >
                <div className="grid gap-6 md:grid-cols-3">
                  <div className="min-w-0">
                    <PanelHeading>
                      {msg("auto.features.dashboard.components.analyticstab.22")}
                    </PanelHeading>
                    <ShareBars
                      bars={chartData.status}
                      color={(bar) => STATUS_COLORS[bar.key] ?? "var(--color-chart-5)"}
                      onSelect={setStatus}
                    />
                  </div>
                  <div className="min-w-0">
                    <PanelHeading>
                      {msg("auto.features.dashboard.components.analyticstab.24")}
                      {TERMS.optimization}
                    </PanelHeading>
                    <ShareBars bars={chartData.jobTypes} />
                  </div>
                  <div className="min-w-0">
                    <PanelHeading>{msg("dashboard.analytics.by_module")}</PanelHeading>
                    {chartData.modules.length > 0 ? (
                      <ShareBars
                        bars={chartData.modules}
                        color={() => "var(--color-chart-4)"}
                      />
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        {msg("auto.shared.charts.chart.utils.literal.1")}
                      </p>
                    )}
                  </div>
                </div>
              </AnalyticsSection>
            </StaggerItem>

            {chartData.modelStats.length > 0 && (
              <StaggerItem>
                <AnalyticsSection
                  title={msg("auto.features.dashboard.components.analyticstab.33")}
                  defaultOpen={true}
                  className="border-border/60"
                >
                  <div className="space-y-3">
                    {chartData.modelStats.map((m, i) => (
                      <div
                        key={m.name}
                        role="button"
                        tabIndex={0}
                        className="min-h-[44px] cursor-pointer space-y-1.5 rounded-md py-1 transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 lg:min-h-0"
                        onClick={() => setModel(m.name)}
                        onKeyDown={(e) => activateOnKey(e, () => setModel(m.name))}
                      >
                        <div className="flex items-center gap-2 text-sm" dir="ltr">
                          <span className="w-4 shrink-0 text-end tabular-nums text-[0.6875rem] text-muted-foreground/70">
                            {i + 1}
                          </span>
                          <span className="min-w-0 truncate font-mono" title={m.name}>
                            {modelDisplayName(m.name)}
                          </span>
                          <span className="ms-auto flex shrink-0 items-center gap-3 tabular-nums">
                            <span className="hidden text-[0.6875rem] text-muted-foreground sm:inline">
                              {Math.round(m.successRate)}%
                            </span>
                            <span
                              className={cn(
                                "hidden text-[0.6875rem] sm:inline",
                                m.avgImprovement != null && m.avgImprovement > 0
                                  ? "text-emerald-600"
                                  : "text-muted-foreground",
                              )}
                            >
                              {pointsText(m.avgImprovement)}
                            </span>
                            <span className="font-medium">{m.count}</span>
                          </span>
                        </div>
                        <div className="ms-6 h-2 overflow-hidden rounded-full bg-muted" dir="ltr">
                          <div
                            className="h-full rounded-full transition-all"
                            style={{
                              width: `${m.share}%`,
                              backgroundColor: MODEL_RAMP[Math.min(i, MODEL_RAMP.length - 1)],
                            }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </AnalyticsSection>
              </StaggerItem>
            )}

            {chartData.topJobs.length > 0 && (
              <StaggerItem>
                <AnalyticsSection
                  title={
                    <HelpTip text={tip("analytics.leaderboard")}>
                      {msg("dashboard.analytics.leaderboard")}
                    </HelpTip>
                  }
                  defaultOpen={true}
                  className="border-border/60"
                >
                  <Leaderboard jobs={chartData.topJobs} onOpenJob={onOpenJob} />
                </AnalyticsSection>
              </StaggerItem>
            )}

            {(showOwners || showAccess) && (
              <StaggerItem>
                <AnalyticsSection
                  title={msg("dashboard.analytics.sharing_breakdown")}
                  defaultOpen={true}
                  className="border-border/60"
                >
                  <SharingBreakdown
                    owners={chartData.ownerUsage}
                    access={chartData.accessUsage}
                    showOwners={showOwners}
                    showAccess={showAccess}
                    sessionUser={sessionUser}
                    onOwnerSelect={setOwner}
                    onAccessSelect={setAccess}
                  />
                </AnalyticsSection>
              </StaggerItem>
            )}
          </StaggerContainer>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

export const AnalyticsTab = memo(AnalyticsTabImpl);
