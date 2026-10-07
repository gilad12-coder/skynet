"use client";

import { AppSkeletonTheme, Skeleton } from "@/shared/ui/skeleton";

/**
 * Loading placeholder for the /storage route, in StorageView's order and line
 * heights: the usage figure row, the gauge and its percent caption, then the
 * per-category breakdown buttons (one per backend category).
 */
export function StorageSkeleton() {
  return (
    <AppSkeletonTheme>
      <div className="pb-16" aria-hidden="true">
        <section className="mt-8">
          <div className="flex h-8 items-center justify-between gap-3">
            <Skeleton height={22} width={150} containerClassName="flex leading-none" />
            <Skeleton height={10} width={64} containerClassName="flex leading-none" />
          </div>
          <div className="mt-3">
            <Skeleton height={6} borderRadius={9999} containerClassName="block leading-none" />
          </div>
          <div className="mt-2 flex h-4 items-center">
            <Skeleton height={10} width={90} containerClassName="flex leading-none" />
          </div>
        </section>

        <section className="mt-10">
          <div className="flex h-5 items-center">
            <Skeleton height={12} width={110} containerClassName="flex leading-none" />
          </div>
          <div className="mt-3 flex flex-col gap-1.5">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="min-h-12 px-2 py-2">
                <div className="flex h-5 items-center justify-between gap-2">
                  <Skeleton
                    height={12}
                    width={`${28 + ((i * 11) % 20)}%`}
                    containerClassName="flex-1 leading-none"
                  />
                  <Skeleton height={12} width={52} containerClassName="flex leading-none" />
                </div>
                <div className="mt-1">
                  <Skeleton
                    height={4}
                    borderRadius={9999}
                    containerClassName="block leading-none"
                  />
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </AppSkeletonTheme>
  );
}
