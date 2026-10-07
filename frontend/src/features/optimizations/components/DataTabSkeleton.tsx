"use client";

import { Skeleton } from "@/shared/ui/skeleton";

// Segmented and icon buttons are 44px tall below lg and under any coarse
// pointer (iPad, even with a trackpad), so the bones grow at the same points.
const SEGMENT_BONE = "block h-6 max-lg:h-11 any-pointer-coarse:h-11";
const ICON_BONE = "block size-8 any-pointer-coarse:size-11";

export function DataTabSkeleton() {
  return (
    <div className="space-y-4 mt-4" aria-hidden="true">
      <div>
        <div className="flex h-5 items-center">
          <Skeleton height={14} containerClassName="block w-full lg:w-[85%]" />
        </div>
        <div className="flex h-5 items-center lg:hidden">
          <Skeleton height={14} containerClassName="block w-[45%]" />
        </div>
      </div>

      <div className="rounded-2xl border border-[#E5DDD4] bg-gradient-to-l from-[#FAF8F5] to-[#F5F1EC] p-4 space-y-3">
        <div className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <Skeleton width={140} height={14} />
          </div>
          <Skeleton
            height="100%"
            borderRadius={8}
            containerClassName="block h-9 w-[70px] shrink-0 max-lg:h-12 max-lg:w-[94px] any-pointer-coarse:h-12 any-pointer-coarse:w-[94px]"
          />
        </div>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="grid w-full grid-cols-4 gap-0.5 rounded-lg bg-muted p-0.5">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} height="100%" containerClassName={SEGMENT_BONE} />
          ))}
        </div>
        <Skeleton width={64} height={10} containerClassName="me-auto" />
        <Skeleton height="100%" containerClassName={ICON_BONE} />
        <Skeleton height="100%" containerClassName={ICON_BONE} />
      </div>

      <div className="relative rounded-2xl border border-[#DDD4C8]/50 bg-gradient-to-b from-white/95 to-[#F8F4EF] py-5 overflow-hidden">
        <div className="max-h-[520px] overflow-hidden">
          <div className="flex h-12 items-center gap-4 border-b border-border/70 px-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} height={14} containerClassName="flex-1" />
            ))}
          </div>
          {Array.from({ length: 12 }).map((_, i) => (
            <div
              key={i}
              className="flex h-10 items-center gap-4 border-b border-border/60 px-2 last:border-0"
            >
              <Skeleton height={12} containerClassName="flex-1" width="55%" />
              <Skeleton height={12} containerClassName="flex-1" width="80%" />
              <Skeleton height={12} containerClassName="flex-1" width="70%" />
              <Skeleton height={12} containerClassName="flex-1" width="45%" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
