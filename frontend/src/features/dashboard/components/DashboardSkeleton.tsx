"use client";

import { Fragment } from "react";
import { Skeleton } from "@/shared/ui/skeleton";
import { Card, CardContent } from "@/shared/ui/primitives/card";
import { SLIDING_PILL_TABS_LIST_CLASS } from "@/shared/ui/primitives/tabs";
import { useIsPhone } from "@/shared/hooks/use-device-class";
import { cn } from "@/shared/lib/utils";
import { WorkspaceStripSkeleton } from "./WorkspaceStrip";

// DashboardHeader always shows these five cells; the stopped/shared cells only
// appear when their counts are non-zero, so they are not reserved here.
const STAT_CELLS = 5;

function StatCell() {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3 px-4 py-4 sm:gap-3.5 sm:px-5 sm:py-5">
      <div className="flex min-w-0 items-center gap-2 text-[0.625rem]">
        <Skeleton width={6} height={6} circle />
        <Skeleton width={64} height={8} />
      </div>
      <div className="text-2xl leading-none sm:text-[2rem]">
        <Skeleton width={48} height="1em" />
      </div>
    </div>
  );
}

function StatStrip() {
  return (
    <div className="grid grid-cols-2 items-stretch sm:flex">
      {Array.from({ length: STAT_CELLS }).map((_, i) => (
        <Fragment key={i}>
          {i > 0 && <div className="my-4 hidden w-px shrink-0 bg-[#DDD4C8]/50 sm:block" />}
          <StatCell />
        </Fragment>
      ))}
    </div>
  );
}

// Same tracks, in the same order, as JobsTab's default column widths. The
// real table never drops columns off-phone, it scrolls inside its wrapper, so
// the bones keep every column at every non-phone width and scroll the same way.
const ROW_GRID =
  "grid grid-cols-[48px_minmax(86px,86fr)_minmax(104px,104fr)_minmax(80px,80fr)_minmax(94px,94fr)_minmax(94px,94fr)_minmax(72px,72fr)_minmax(94px,94fr)_minmax(66px,66fr)_minmax(94px,94fr)_32px] items-center";

const HEADER_WIDTHS = [40, 40, 40, 40, 40, 40, 40, 40, 40];
const CELL_WIDTHS: Array<{ width: number | string; height: number; pill?: boolean }> = [
  { width: "80%", height: 14 },
  { width: "70%", height: 14 },
  { width: 56, height: 20, pill: true },
  { width: 56, height: 20, pill: true },
  { width: 64, height: 14 },
  { width: 32, height: 14 },
  { width: 64, height: 14 },
  { width: 48, height: 14 },
  { width: 56, height: 14 },
];

function HeaderRow() {
  return (
    // th is h-12; its sort/filter buttons take the 44px coarse floor plus py-2.
    <div
      className={cn(
        ROW_GRID,
        "h-12 border-b border-border/60 bg-muted/40 any-pointer-coarse:h-[60px]",
      )}
    >
      <span className="flex justify-center">
        <Skeleton width={16} height={16} borderRadius={4} />
      </span>
      {HEADER_WIDTHS.map((width, i) => (
        <span key={i} className="ps-1 pe-2">
          <Skeleton height={11} width={width} />
        </span>
      ))}
      <span />
    </div>
  );
}

function TableRow() {
  return (
    // The ID cell is a button, so under a coarse pointer it sets a 44px row floor.
    <div className={cn(ROW_GRID, "h-[42px] border-b border-border/30 any-pointer-coarse:h-16")}>
      <span className="flex justify-center">
        <Skeleton width={16} height={16} borderRadius={4} />
      </span>
      {CELL_WIDTHS.map((cell, i) => (
        <span key={i} className="px-2">
          <Skeleton
            height={cell.height}
            width={cell.width}
            borderRadius={cell.pill ? 10 : undefined}
          />
        </span>
      ))}
      <span className="flex justify-center">
        <Skeleton width={14} height={14} borderRadius={4} />
      </span>
    </div>
  );
}

/** Mirrors PhoneJobList: one card per run with title + status, meta and timing lines. */
function PhoneRow() {
  return (
    <li className="flex items-center gap-3 rounded-2xl border border-input bg-background px-3 py-3 shadow-xs sm:gap-3.5 sm:px-4">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-center gap-2 text-sm">
          <Skeleton height={14} width="60%" containerClassName="min-w-0 flex-1" />
          <Skeleton width={56} height={20} borderRadius={10} />
        </div>
        <div className="flex items-center text-xs">
          <Skeleton height={12} width="75%" containerClassName="min-w-0 flex-1" />
        </div>
        <div className="flex items-center gap-2 text-xs">
          <Skeleton width={72} height={12} />
          <Skeleton width={40} height={12} containerClassName="ms-auto" />
        </div>
      </div>
      <Skeleton width={16} height={16} borderRadius={4} />
    </li>
  );
}

export function DashboardSkeleton() {
  const isPhone = useIsPhone();

  return (
    <div className="flex flex-col gap-6 -mt-2 md:-mt-4 pb-16" aria-hidden="true">
      <Card className="gap-0 p-0">
        <StatStrip />
        <WorkspaceStripSkeleton />
      </Card>

      {/* Tabs root is flex-col gap-2; the pill list is a fixed 44px row. */}
      <div className="flex flex-col gap-2">
        <div className={cn(SLIDING_PILL_TABS_LIST_CLASS, "h-11")}>
          <Skeleton containerClassName="flex flex-1" className="h-full" borderRadius={999} />
          <Skeleton containerClassName="flex flex-1" className="h-full" borderRadius={999} />
        </div>

        <Card className="overflow-hidden border-border/60">
          <CardContent className="px-3 pt-4 sm:px-6 sm:pt-5">
            <div className="mb-3 flex min-h-[44px] items-center gap-2 text-[0.6875rem] lg:min-h-0">
              <Skeleton width={64} height={11} />
              <span className="ms-auto flex size-8 any-pointer-coarse:size-11">
                <Skeleton containerClassName="flex flex-1" className="h-full" borderRadius={6} />
              </span>
            </div>

            {isPhone ? (
              <ul className="flex flex-col gap-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <PhoneRow key={i} />
                ))}
              </ul>
            ) : (
              <div className="overflow-x-auto rounded-2xl border border-border/40 bg-card/60">
                <HeaderRow />
                {Array.from({ length: 4 }).map((_, i) => (
                  <TableRow key={i} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
