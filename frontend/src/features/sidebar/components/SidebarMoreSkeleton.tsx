"use client";

import { Skeleton } from "@/shared/ui/skeleton";

const ROW_WIDTHS = ["100%", "80%", "60%"];

// Mirrors JobRow: the name link takes a 44px floor below lg, and on any coarse
// pointer both it and the size-7 row menu button grow to 44px (globals.css),
// so the bones reserve those heights and appended rows don't grow on arrival.
export function SidebarMoreSkeleton() {
  return (
    <ul className="flex flex-col gap-1" aria-hidden="true">
      {ROW_WIDTHS.map((width, i) => (
        <li
          key={i}
          className="flex min-h-[44px] items-center gap-1.5 rounded-lg px-2 py-2 lg:min-h-0"
        >
          <span className="flex min-h-[44px] min-w-0 flex-1 items-center gap-2 lg:min-h-0 any-pointer-coarse:min-h-[44px]">
            <Skeleton height={11} width={width} containerClassName="flex-1" />
            <Skeleton circle width={8} height={8} />
          </span>
          <span className="flex size-7 shrink-0 items-center justify-center any-pointer-coarse:size-11">
            <Skeleton circle width={14} height={14} />
          </span>
        </li>
      ))}
    </ul>
  );
}
