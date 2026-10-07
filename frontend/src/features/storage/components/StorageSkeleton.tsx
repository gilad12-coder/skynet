"use client";

import { ProgressBar, StorageUsageBar } from "@/shared/ui/progress-bar";
import { AppSkeletonTheme, Skeleton } from "@/shared/ui/skeleton";
import { hintedCount, useLayoutHint } from "@/shared/lib/layout-hint";

/** Remembers how many categories the breakdown last listed, for the next skeleton. */
export const STORAGE_LAYOUT_KEY = "storage-categories";

/**
 * Loading placeholder for the /storage route, built on StorageView's own
 * elements and text classes so every line takes the real line height: the
 * usage figure row, the (empty) gauge and its percent caption, then one
 * breakdown button per category — as many as the page last listed, or the
 * three a typical account has on a cold visit.
 */
export function StorageSkeleton() {
  const rows = hintedCount(useLayoutHint<number>(STORAGE_LAYOUT_KEY), 3, 4);
  return (
    <AppSkeletonTheme>
      <div className="pb-16" aria-hidden="true">
        <section className="mt-8">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-foreground">
              <span className="text-2xl font-semibold">
                <Skeleton inline width={84} />
              </span>
              <span className="ms-1.5 text-sm">
                <Skeleton inline width={64} />
              </span>
            </p>
            <span className="shrink-0 text-xs">
              <Skeleton width={64} />
            </span>
          </div>
          <StorageUsageBar value={0} className="mt-3" />
          <p className="mt-2 text-xs">
            <Skeleton width={90} />
          </p>
        </section>

        <section className="mt-10">
          <h2 className="text-sm font-semibold">
            <Skeleton width={160} />
          </h2>
          {rows > 0 && (
            <div className="mt-3 flex flex-col gap-1.5">
              {Array.from({ length: rows }).map((_, i) => (
                // The row is a button, so a touch pointer's global 44px floor
                // replaces its min-h-12.
                <div key={i} className="min-h-12 px-2 py-2 any-pointer-coarse:min-h-[44px]">
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <Skeleton width={`${28 + ((i * 11) % 20)}%`} containerClassName="flex-1" />
                    <Skeleton width={52} />
                  </div>
                  <ProgressBar value={0} size="sm" className="mt-1 bg-[#E5DDD4]/60" />
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </AppSkeletonTheme>
  );
}
