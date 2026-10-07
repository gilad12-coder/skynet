"use client";

import { AppSkeletonTheme, Skeleton } from "@/shared/ui/skeleton";

/**
 * Loading silhouette shared by the Data hub list surfaces (dataset library and
 * labeling-session chooser): the search toolbar (h-11 field + action button)
 * and card rows at their loaded geometry, so the content swap shifts nothing.
 */
export function ListPageSkeleton() {
  return (
    <AppSkeletonTheme>
      {/* The real toolbar stacks below sm, with a full-width action button. */}
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
        <div className="flex-1">
          <Skeleton height={44} borderRadius={16} containerClassName="block leading-none" />
        </div>
        <Skeleton
          height={44}
          borderRadius={16}
          containerClassName="block w-full shrink-0 leading-none sm:w-[150px]"
        />
      </div>

      <div className="mt-5 rounded-xl border border-dashed border-transparent">
        <div className="flex flex-col gap-2.5 p-0.5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} height={66} borderRadius={16} />
          ))}
        </div>
      </div>
    </AppSkeletonTheme>
  );
}
