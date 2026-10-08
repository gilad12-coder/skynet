"use client";

import { Ghost, Skeleton } from "@/shared/ui/skeleton";

export const SIDEBAR_RUNS_LAYOUT_KEY = "sidebar-runs";

// The sidebar shows roughly this many rows before it scrolls; rows past it are
// never seen while the first page loads.
const MAX_HINTED_ROWS = 30;

/** Group sizes trimmed to the rows one screen of the sidebar can show. */
export function sidebarRunGroups(sizes: number[]): number[] {
  const out: number[] = [];
  let left = MAX_HINTED_ROWS;
  for (const size of sizes) {
    if (left <= 0) break;
    const take = Math.min(Math.max(0, Math.floor(size)), left);
    if (take > 0) out.push(take);
    left -= take;
  }
  return out;
}

const ROW_WIDTHS = ["100%", "80%", "60%"];

// Mirrors JobRow: the name link takes a 44px floor below lg, and on any coarse
// pointer both it and the size-7 row menu button grow to 44px (globals.css),
// so the bones reserve those heights and appended rows don't grow on arrival.
export function SidebarMoreSkeleton({ rows = ROW_WIDTHS.length }: { rows?: number }) {
  return (
    <ul className="flex flex-col" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => ROW_WIDTHS[i % ROW_WIDTHS.length]).map((width, i) => (
        <li
          key={i}
          className="flex min-h-[44px] items-center gap-1.5 rounded-lg px-2 py-2 lg:min-h-0"
        >
          <span className="flex min-h-[44px] min-w-0 flex-1 items-center gap-2 lg:min-h-0 any-pointer-coarse:min-h-[44px]">
            <Skeleton height={11} width={width} containerClassName="flex-1" />
            <Skeleton circle width={8} height={8} />
          </span>
          <span className="flex size-7 shrink-0 items-center justify-center any-pointer-coarse:size-[44px]">
            <Skeleton circle width={14} height={14} />
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The run list while its first page loads: the date groups and row counts it
 * last showed (see `sidebarRunGroups`), or one generic group on a cold visit.
 */
export function SidebarRunsSkeleton({ groups }: { groups?: number[] }) {
  const sizes = Array.isArray(groups) && groups.length > 0 ? sidebarRunGroups(groups) : [3];
  return (
    <div aria-hidden="true">
      {sizes.map((rows, i) => (
        <div key={i} className="mb-2">
          {/* Same type as the group heading, so the bone takes its line height. */}
          <p className="flex items-center gap-1.5 text-[0.625rem] font-semibold uppercase tracking-[0.12em] px-2 py-1.5">
            <Ghost>
              <span className="rounded-sm">00/00/0000</span>
            </Ghost>
          </p>
          <SidebarMoreSkeleton rows={rows} />
        </div>
      ))}
    </div>
  );
}
