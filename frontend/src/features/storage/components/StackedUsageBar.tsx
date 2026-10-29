"use client";

import { formatStorageSize } from "@/shared/lib/formatters";
import { cn } from "@/shared/lib/utils";
import { categoryLabel, categoryMeta } from "../lib/categories";

/**
 * The usage gauge split into one coloured slice per category, so the bar itself
 * shows where the space went. The uncoloured remainder is the free space; past
 * the quota the slices scale to the used total and the track turns destructive.
 */
export function StackedUsageBar({
  rows,
  quota,
  className,
}: {
  rows: Array<{ key: string; bytes: number }>;
  quota: number;
  className?: string;
}) {
  const slices = rows.filter((r) => r.bytes > 0 && categoryMeta(r.key));
  const used = rows.reduce((sum, r) => sum + r.bytes, 0);
  const scale = Math.max(quota, used);
  const over = quota > 0 && used > quota;
  return (
    <div
      className={cn(
        "flex h-2.5 w-full gap-px overflow-hidden rounded-full",
        over ? "bg-destructive/25 ring-1 ring-destructive/60" : "bg-border-subtle",
        className,
      )}
      role="img"
      aria-label={slices
        .map((r) => `${categoryLabel(r.key)} ${formatStorageSize(r.bytes)}`)
        .join(", ")}
    >
      {scale > 0 &&
        slices.map((r) => (
          <span
            key={r.key}
            className={cn(
              "h-full transition-[width] duration-500 ease-out",
              categoryMeta(r.key)?.swatch,
            )}
            // Keep a sliver visible for categories too small to see at true scale.
            style={{ width: `max(3px, ${(r.bytes / scale) * 100}%)` }}
          />
        ))}
    </div>
  );
}
