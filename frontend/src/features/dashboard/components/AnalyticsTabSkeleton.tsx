"use client";

import { Skeleton } from "@/shared/ui/skeleton";
import { cn } from "@/shared/lib/utils";
import { AnalyticsSection } from "./AnalyticsSection";
import { BREAKDOWN_GRID_CLASS, BREAKDOWN_WIDE_CELL_CLASS } from "../constants";

function KpiCard() {
  return (
    <div className="flex h-full min-h-[9.5rem] min-w-0 flex-col gap-4 rounded-2xl border border-border/40 bg-card/60 p-5 sm:p-6">
      <div className="flex items-center gap-2 text-[0.625rem]">
        <Skeleton width={6} height={6} circle />
        <Skeleton width={90} height={10} />
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-2">
        <div className="text-[2.5rem] leading-[0.9] sm:text-[3rem]">
          <Skeleton width={120} height="0.9em" />
        </div>
        <div className="min-h-[1rem] text-[0.6875rem]" />
      </div>
    </div>
  );
}

function PanelHeadingBone({ width }: { width: number }) {
  return (
    <div className="mb-3 text-[0.6875rem]">
      <Skeleton width={width} height={11} />
    </div>
  );
}

/** Mirrors an interactive ShareBars row, which takes the 44px tap floor below lg and on touch. */
function BarRow() {
  return (
    <div className="min-h-[44px] space-y-1.5 py-1 lg:min-h-0 any-pointer-coarse:min-h-[44px]">
      <div className="flex items-center justify-between text-[0.8125rem]">
        <Skeleton width={120} height={13} />
        <Skeleton width={28} height={13} />
      </div>
      <Skeleton height={8} borderRadius={9999} />
    </div>
  );
}

function BarColumn({ rows, className }: { rows: number; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <PanelHeadingBone width={100} />
      <div className="space-y-2.5">
        {Array.from({ length: rows }).map((_, i) => (
          <BarRow key={i} />
        ))}
      </div>
    </div>
  );
}

function SectionTitle() {
  return <Skeleton width={200} height="1em" />;
}

export function AnalyticsTabSkeleton() {
  return (
    <div className="space-y-6" aria-hidden="true">
      {/* Range control: sm Segmented, 44px radios + 2px track inset below lg and on touch. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="flex h-12 w-[220px] lg:h-7 any-pointer-coarse:h-12">
          <Skeleton containerClassName="flex flex-1" className="h-full" borderRadius={8} />
        </span>
      </div>

      <div className="grid auto-rows-fr grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 xl:grid-cols-5">
        <KpiCard />
        <KpiCard />
        <KpiCard />
        <KpiCard />
        <KpiCard />
      </div>

      <AnalyticsSection title={<SectionTitle />} className="border-border/60">
        <div className="grid gap-6 md:grid-cols-2">
          <div className="min-w-0">
            <PanelHeadingBone width={140} />
            <Skeleton height={240} borderRadius={10} />
          </div>
          <div className="min-w-0">
            <PanelHeadingBone width={140} />
            <Skeleton height={240} borderRadius={10} />
          </div>
        </div>
        <div className="mt-6 min-w-0">
          <PanelHeadingBone width={140} />
          <Skeleton height={240} borderRadius={10} />
        </div>
      </AnalyticsSection>

      <AnalyticsSection title={<SectionTitle />} className="border-border/60">
        <Skeleton height={220} borderRadius={10} />
      </AnalyticsSection>

      <AnalyticsSection title={<SectionTitle />} className="border-border/60">
        <div className={BREAKDOWN_GRID_CLASS}>
          <BarColumn rows={3} />
          <BarColumn rows={2} />
          <BarColumn rows={2} className={BREAKDOWN_WIDE_CELL_CLASS} />
        </div>
      </AnalyticsSection>
    </div>
  );
}
