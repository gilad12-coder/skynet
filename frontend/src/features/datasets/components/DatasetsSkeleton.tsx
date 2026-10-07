"use client";

import { AppSkeletonTheme, Skeleton } from "@/shared/ui/skeleton";

/**
 * Loading silhouette for the dataset library below the Data hub tabs. Mirrors
 * DatasetsView region by region: the search + import + upload toolbar (stacked
 * below sm, one row from sm), then DatasetCard rows on the LIST_ROW geometry,
 * whose action strip wraps under the text below sm and whose icon buttons grow
 * to 44px under a coarse pointer, as the real ones do.
 */
export function DatasetsSkeleton() {
  return (
    <AppSkeletonTheme>
      <div aria-hidden="true">
        <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
          <Skeleton height={44} borderRadius={16} containerClassName="block flex-1 leading-none" />
          <Skeleton
            height={44}
            borderRadius={16}
            containerClassName="block w-full shrink-0 leading-none sm:w-36"
          />
          <Skeleton
            height={44}
            borderRadius={16}
            containerClassName="block w-full shrink-0 leading-none sm:w-28"
          />
        </div>

        <div className="mt-5 rounded-xl border border-dashed border-transparent">
          <div className="flex flex-col gap-2.5 p-0.5">
            {Array.from({ length: 5 }).map((_, i) => (
              <CardBone key={i} index={i} />
            ))}
          </div>
        </div>
      </div>
    </AppSkeletonTheme>
  );
}

function CardBone({ index }: { index: number }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-input bg-background px-3 py-3 shadow-xs sm:flex-nowrap sm:gap-3.5 sm:px-4">
      <Skeleton width={20} height={20} borderRadius={6} containerClassName="flex leading-none" />
      <Skeleton width={36} height={36} borderRadius={12} containerClassName="flex leading-none" />
      <div className="min-w-0 flex-1">
        <div className="flex h-5 items-center">
          <Skeleton
            height={13}
            width={`${45 + ((index * 17) % 30)}%`}
            containerClassName="flex-1 leading-none"
          />
        </div>
        <div className="mt-1 flex h-4 items-center">
          <Skeleton height={10} width="65%" containerClassName="flex-1 leading-none" />
        </div>
      </div>
      <div className="flex w-full shrink-0 items-center justify-end gap-0.5 border-t border-border/40 pt-2 sm:w-auto sm:border-t-0 sm:pt-0">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="flex size-8 items-center justify-center any-pointer-coarse:size-11"
          >
            <Skeleton
              width={16}
              height={16}
              borderRadius={4}
              containerClassName="flex leading-none"
            />
          </div>
        ))}
      </div>
    </div>
  );
}
