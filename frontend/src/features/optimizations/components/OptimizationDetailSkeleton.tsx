"use client";

import type { CSSProperties } from "react";
import { useParams } from "next/navigation";
import { CLIMB_CHART_HEIGHT_PX, useClimbViewHint } from "@/features/trajectory";
import { Skeleton } from "@/shared/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/shared/ui/primitives/card";

/*
 * Mirrors OptimizationDetailView: header card, optional pair strip, tab bar,
 * then the Overview body. A grid-search summary (`grid`, known from a
 * remembered run kind) gets the grid's own body: best-pair cards, charts and
 * pair cards. Every other kind, a grid pair view included, gets the run
 * Overview (status line, pipeline, score cards, trajectory).
 */

// Icon buttons are size-8, and globals.css grows them to 44px under a coarse
// pointer (every iPad), so the bones grow with them.
function IconButtonBone() {
  return (
    <span className="flex size-8 any-pointer-coarse:size-11">
      <Skeleton containerClassName="flex-1 leading-none" height="100%" borderRadius={8} />
    </span>
  );
}

// Chart cards in GridOverview: a title row, a fixed-height plot, then a legend.
function GridChartCardBone({ plotHeight, className }: { plotHeight: number; className?: string }) {
  return (
    <Card className={className}>
      <CardHeader className="pb-2">
        <span className="flex h-6 items-center">
          <Skeleton width={160} height={16} />
        </span>
      </CardHeader>
      <CardContent className="pt-0">
        <Skeleton height={plotHeight} borderRadius={12} />
        <div className="mt-2 flex h-4 items-center justify-center gap-4">
          <Skeleton width={72} height={10} />
          <Skeleton width={72} height={10} />
        </div>
      </CardContent>
    </Card>
  );
}

function GridOverviewBone() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-border/50 bg-card/80 p-4 text-center">
            <div className="mb-1 flex h-[15px] items-center justify-center">
              <Skeleton width={56} height={10} containerClassName="leading-none" />
            </div>
            <div className="flex h-4 items-center justify-center">
              <Skeleton width={140} height={11} containerClassName="leading-none" />
            </div>
            <div className="mt-0.5 flex h-5 items-center justify-center">
              <Skeleton width={48} height={14} containerClassName="leading-none" />
            </div>
          </div>
        ))}
      </div>

      <div>
        <GridChartCardBone plotHeight={280} className="mb-4" />
        <div className="grid gap-4 lg:grid-cols-2">
          <GridChartCardBone plotHeight={220} />
          <GridChartCardBone plotHeight={220} />
        </div>
        <GridChartCardBone plotHeight={220} className="mt-4" />
      </div>

      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-border/50 bg-card/80 p-4">
            <div className="flex min-h-[30px] items-center gap-3 any-pointer-coarse:min-h-11">
              <span className="block w-[45%] max-w-[260px]">
                <Skeleton height={12} />
              </span>
              <span className="flex-1" />
              <Skeleton width={110} height={24} />
              {/* The pair's icon-xs Delete button, 44px under a coarse pointer. */}
              <span className="flex size-7 any-pointer-coarse:size-11">
                <Skeleton containerClassName="flex-1 leading-none" height="100%" borderRadius={6} />
              </span>
            </div>
            <div className="mt-2.5 flex h-1 items-center">
              <Skeleton height={4} borderRadius={2} containerClassName="flex-1 leading-none" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function OptimizationDetailSkeleton({
  pair = false,
  grid = false,
}: {
  pair?: boolean;
  grid?: boolean;
}) {
  const gridSummary = grid && !pair;
  const params = useParams<{ id?: string }>();
  const climb = useClimbViewHint(params?.id);
  return (
    <div className="space-y-6 pb-12" aria-hidden="true">
      <div
        className="rounded-xl border border-border/40 bg-gradient-to-br from-card to-card/80 p-4 sm:p-5"
        data-tutorial="detail-header-skeleton"
      >
        <div className="flex flex-wrap items-start justify-between gap-4 sm:flex-nowrap">
          <div className="min-w-0 space-y-2 sm:flex-1">
            <div className="flex flex-col items-start gap-1.5">
              <Skeleton width={72} height={26} borderRadius={13} />
              <span className="block w-[55%] max-w-[320px]">
                <Skeleton height={24} />
              </span>
            </div>
            <span className="block w-[80%] max-w-[420px]">
              <Skeleton height={12} />
            </span>
            <div className="flex min-h-6 items-center any-pointer-coarse:min-h-11">
              <span className="block w-[40%] max-w-[220px]">
                <Skeleton height={10} />
              </span>
            </div>
            {/* The cost chip is a 44px target on phones and coarse pointers. */}
            <div className="flex min-h-11 flex-wrap items-center gap-3 sm:min-h-5 any-pointer-coarse:min-h-11">
              <Skeleton width={60} height={16} />
              <Skeleton width={84} height={16} />
            </div>
          </div>
          <div className="flex w-full items-center justify-end gap-1 sm:w-auto sm:shrink-0 sm:gap-2">
            <IconButtonBone />
            <IconButtonBone />
            <IconButtonBone />
          </div>
        </div>
      </div>

      {pair && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#C8A882]/30 bg-gradient-to-l from-[#FAF8F5] to-[#F5F1EC] p-3">
          <div className="flex min-h-8 min-w-0 flex-1 flex-wrap items-center gap-3">
            <Skeleton width={64} height={14} />
            <span aria-hidden="true" className="h-4 w-px bg-[#C8A882]/30" />
            <Skeleton width={160} height={14} />
          </div>
          <div className="flex w-full items-center justify-end gap-1 sm:w-auto sm:shrink-0">
            <IconButtonBone />
            <IconButtonBone />
            <IconButtonBone />
          </div>
        </div>
      )}

      <div className="flex h-11 items-stretch overflow-hidden border-b border-border/50">
        {/* A finished grid summary has five tabs: no Data, Logs or Artifact. */}
        {Array.from({ length: gridSummary ? 5 : 6 }).map((_, i) => (
          <span
            key={i}
            className={`flex min-h-[44px] shrink-0 items-center gap-1.5 border-b-2 px-2.5 sm:px-4 ${
              i === 0 ? "border-b-primary/30" : "border-transparent"
            }`}
          >
            <Skeleton width={14} height={14} />
            <Skeleton width={48} height={12} />
          </span>
        ))}
      </div>

      {gridSummary ? (
        <GridOverviewBone />
      ) : (
        <div className="space-y-6">
          <span className="block w-[70%] max-w-[460px]">
            <Skeleton height={14} />
          </span>

          {/* PipelineStages goes vertical below 600px of its own width, which
            covers phones, split windows and 11-inch iPad portrait. */}
          <div className="@container">
            <div className="flex flex-col @min-[600px]:hidden">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 px-1 py-1.5">
                  <Skeleton circle width={32} height={32} />
                  <Skeleton width={88} height={12} />
                </div>
              ))}
            </div>
            <div className="hidden grid-cols-5 @min-[600px]:grid">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex flex-col items-center gap-2 px-1 pb-1">
                  <Skeleton circle width={32} height={32} />
                  <Skeleton width={56} height={12} />
                  <Skeleton width={36} height={10} />
                </div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="rounded-xl border border-border/50 bg-card p-6 text-center">
                <div className="mb-2 flex h-4 items-center justify-center">
                  <Skeleton width={96} height={11} containerClassName="leading-none" />
                </div>
                <div className="flex h-9 items-center justify-center">
                  <Skeleton width={110} height={30} containerClassName="leading-none" />
                </div>
              </div>
            ))}
          </div>

          <Card className="relative overflow-hidden">
            <CardHeader className="flex flex-row items-center justify-between gap-3">
              <span className="flex h-6 items-center gap-2">
                <Skeleton width={16} height={16} />
                <Skeleton width={120} height={16} />
              </span>
              <Skeleton width={72} height={12} />
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="rounded-xl border border-border/40 bg-background/70 px-4 pt-3 pb-4">
                <div className="mb-3 flex h-[15px] items-center">
                  <Skeleton width={88} height={10} containerClassName="leading-none" />
                </div>
                <div className="flex h-9 items-center">
                  <Skeleton height={4} borderRadius={2} containerClassName="flex-1 leading-none" />
                </div>
              </div>
              {/* TrajectoryTree's fixed 560px canvas, or the shorter climb chart
                  when this run is remembered to draw one. */}
              {climb ? (
                <div
                  className="h-(--climb-h) any-pointer-coarse:h-(--climb-h-coarse)"
                  style={
                    {
                      "--climb-h": `${CLIMB_CHART_HEIGHT_PX.fine}px`,
                      "--climb-h-coarse": `${CLIMB_CHART_HEIGHT_PX.coarse}px`,
                    } as CSSProperties
                  }
                >
                  <Skeleton
                    height="100%"
                    borderRadius={12}
                    containerClassName="block h-full leading-none"
                  />
                </div>
              ) : (
                <Skeleton height={560} borderRadius={12} />
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
