"use client";

import * as React from "react";
import { Skeleton } from "@/shared/ui/skeleton";

interface ResultsSkeletonProps {
  /** Number of placeholder rows to render. */
  rows?: number;
}

// Segmented sm segments are 44px tall below lg and under any coarse pointer
// (the global touch-target rule), 24px otherwise, inside a 2px track inset.
const SEGMENTED_SM_HEIGHT = "h-12 lg:h-7 any-pointer-coarse:h-12";

/**
 * Placeholder rows shown while a fresh query is in flight and there are no
 * prior results to keep on screen. Matches the rhythm of ResultsList (title,
 * two-line summary, meta strip with the date at the end) so the page doesn't
 * jump when real rows replace it.
 */
export function ResultsSkeleton({ rows = 4 }: ResultsSkeletonProps) {
  return (
    <ul aria-hidden="true" className="divide-y divide-border/55">
      {Array.from({ length: rows }).map((_, i) => (
        <li key={i} className="flex flex-col gap-2 rounded-lg px-3 py-4">
          <div className="flex h-[21px] items-center">
            <Skeleton
              height={14}
              width={`${50 + ((i * 13) % 30)}%`}
              borderRadius={4}
              containerClassName="flex-1 leading-none"
            />
          </div>
          <div className="flex h-11 max-w-[72ch] flex-col justify-around">
            <Skeleton height={11} borderRadius={4} containerClassName="block leading-none" />
            <Skeleton
              height={11}
              width="70%"
              borderRadius={4}
              containerClassName="block leading-none"
            />
          </div>
          <div className="flex h-[17px] items-center">
            <Skeleton
              height={10}
              width={72}
              borderRadius={4}
              containerClassName="ms-auto flex leading-none"
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Stand-in for ResultsToolbar: the result count and the sort control. */
export function ResultsToolbarSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-1 pb-2"
    >
      <Skeleton height={10} width={64} containerClassName="flex leading-none" />
      <div className="inline-flex items-center gap-1.5">
        <Skeleton width={12} height={12} borderRadius={3} containerClassName="flex leading-none" />
        <Skeleton
          width={176}
          height="100%"
          borderRadius={8}
          containerClassName={`block leading-none ${SEGMENTED_SM_HEIGHT}`}
        />
      </div>
    </div>
  );
}

/** Stand-in for the Explore corpus toggle (full width below sm, as the real one). */
export function CorpusToggleSkeleton() {
  return (
    <Skeleton
      height="100%"
      borderRadius={8}
      containerClassName={`block w-full leading-none sm:w-64 ${SEGMENTED_SM_HEIGHT}`}
    />
  );
}
