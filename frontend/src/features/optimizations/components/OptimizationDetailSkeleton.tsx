"use client";

import { Skeleton } from "@/shared/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/shared/ui/primitives/card";

/*
 * Mirrors OptimizationDetailView: header card, optional pair strip, tab bar,
 * then the run Overview (status line, pipeline, score cards, trajectory).
 * The run's kind is unknown until the probe returns, so the body follows the
 * run/black-box Overview, which every kind except the grid summary renders.
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

export function OptimizationDetailSkeleton({ pair = false }: { pair?: boolean }) {
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
        {Array.from({ length: 6 }).map((_, i) => (
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
            {/* TrajectoryTree's fixed 560px canvas; the climb view is shorter. */}
            <Skeleton height={560} borderRadius={12} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
