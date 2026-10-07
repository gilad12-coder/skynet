"use client";

import { AppSkeletonTheme, Skeleton } from "@/shared/ui/skeleton";

const COLUMNS = 3;
const ROWS = 8;

// Touch targets (links, icon buttons, inputs) grow to 44px under a coarse
// pointer through the global rule, so the matching bones grow with them.
const COARSE_44 = "any-pointer-coarse:h-11";

/**
 * Loading silhouette for /datasets/[id]/edit, in DatasetEditorView's order: the
 * back link, the title row with its icon actions, then the editable grid inside
 * the same horizontally scrolling card, with the header, cell and add-row
 * heights the real table renders.
 */
export function DatasetEditorSkeleton() {
  return (
    <AppSkeletonTheme>
      <div className="flex flex-col gap-4 pb-12" aria-hidden="true">
        <div className={`flex h-7 items-center self-start ${COARSE_44}`}>
          <Skeleton width={110} height={12} containerClassName="flex leading-none" />
        </div>

        <div className="flex flex-wrap items-center gap-2 lg:gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex h-7 items-center">
              <Skeleton height={18} width="40%" containerClassName="flex-1 leading-none" />
            </div>
            <div className="flex h-4 items-center">
              <Skeleton height={10} width={120} containerClassName="flex leading-none" />
            </div>
          </div>
          {Array.from({ length: 4 }).map((_, i) => (
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

        <div className="overflow-x-auto rounded-2xl border border-border/40 bg-card/60">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border/60 bg-muted/40">
                <th className="w-12 px-2 py-2">
                  <Skeleton width={10} height={10} containerClassName="flex leading-none" />
                </th>
                {Array.from({ length: COLUMNS }).map((_, i) => (
                  <th key={i} className="min-w-[10rem] px-1 py-1">
                    <div className={`flex h-[26px] items-center px-2 ${COARSE_44}`}>
                      <Skeleton height={10} width="55%" containerClassName="flex-1 leading-none" />
                    </div>
                  </th>
                ))}
                <th className="w-40 px-2 py-1">
                  <div className={`flex h-8 items-center ${COARSE_44}`}>
                    <Skeleton height={10} width={80} containerClassName="flex leading-none" />
                  </div>
                </th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: ROWS }).map((_, row) => (
                <tr key={row} className="border-b border-border/30 last:border-b-0">
                  <td className="px-2 py-1">
                    <Skeleton width={12} height={10} containerClassName="flex leading-none" />
                  </td>
                  {Array.from({ length: COLUMNS }).map((_, col) => (
                    <td key={col} className="px-1 py-0.5">
                      <div className={`flex h-[30px] items-center px-2 ${COARSE_44}`}>
                        <Skeleton
                          height={11}
                          width={`${45 + (((row + 1) * (col + 3) * 7) % 40)}%`}
                          containerClassName="flex-1 leading-none"
                        />
                      </div>
                    </td>
                  ))}
                  <td />
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border/40">
                <td colSpan={COLUMNS + 2} className="p-1">
                  <div className={`flex h-8 items-center px-3 ${COARSE_44}`}>
                    <Skeleton width={70} height={10} containerClassName="flex leading-none" />
                  </div>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </AppSkeletonTheme>
  );
}
