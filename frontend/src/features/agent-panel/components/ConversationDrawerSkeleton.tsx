"use client";

import { Skeleton } from "@/shared/ui/skeleton";

const SECTIONS = [
  { labelWidth: 70, rows: ["90%", "75%", "82%"] },
  { labelWidth: 56, rows: ["68%", "85%"] },
];

// Bones sit inside wrappers carrying the real rows' text sizes, so each bone's
// line box matches the loaded title/preview line; the row keeps the real
// min-h-[44px], and the menu slot grows to 44px under coarse pointers the same
// way the real icon button does, so nothing jumps on touch screens.
export function ConversationDrawerSkeleton() {
  return (
    <div aria-hidden="true">
      {SECTIONS.map((section, s) => (
        <div key={s} className="mt-3">
          <div className="px-2 pb-1 text-[0.625rem]">
            <Skeleton width={section.labelWidth} />
          </div>
          <ul className="space-y-0.5">
            {section.rows.map((width, r) => (
              <li key={r}>
                <div className="flex min-h-[44px] items-center gap-1.5 rounded-md px-2 py-1.5">
                  <div className="min-w-0 flex-1">
                    <div className="text-[0.8125rem]">
                      <Skeleton width={width} />
                    </div>
                    <div className="text-[0.6875rem]">
                      <Skeleton width="55%" />
                    </div>
                  </div>
                  <div className="flex size-7 shrink-0 items-center justify-center any-pointer-coarse:size-11">
                    <Skeleton width={14} height={14} borderRadius={4} />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
