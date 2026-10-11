"use client";

import { AppSkeletonTheme, Skeleton } from "@/shared/ui/skeleton";
import { STORAGE_CATEGORY_ORDER } from "../lib/categories";

/**
 * Loading placeholder for the /storage route, built on StorageView's own
 * elements and text classes so every line takes the real line height: the
 * usage figure row, the (empty) gauge and its percent caption, then one row per
 * storage category — the page always lists every category.
 */
export function StorageSkeleton() {
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
          <div className="mt-3 h-2.5 w-full rounded-full bg-border-subtle" />
          <p className="mt-2 text-xs">
            <Skeleton width={90} />
          </p>
        </section>

        <section className="mt-10">
          <h2 className="text-sm font-semibold">
            <Skeleton width={160} />
          </h2>
          <div className="mt-3 flex flex-col divide-y divide-border-subtle/60">
            {STORAGE_CATEGORY_ORDER.map((key, i) => (
              <div key={key} className="flex min-h-14 items-center gap-3 px-2 py-2.5">
                <Skeleton width={36} height={36} borderRadius={8} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm">
                    <Skeleton width={`${30 + ((i * 11) % 20)}%`} />
                  </div>
                  <div className="mt-0.5 text-xs">
                    <Skeleton width={`${55 + ((i * 7) % 25)}%`} />
                  </div>
                </div>
                <div className="shrink-0 text-end">
                  <div className="text-sm">
                    <Skeleton width={56} />
                  </div>
                  <div className="mt-0.5 text-xs">
                    <Skeleton width={72} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </AppSkeletonTheme>
  );
}
