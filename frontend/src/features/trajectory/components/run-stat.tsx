import type { CSSProperties } from "react";
import { cn } from "@/shared/lib/utils";

// The list pads 4px around its triggers and gaps them by 4px, so each trigger
// takes an equal share of what is left; the pill mirrors the active one.
export function slidingPillStyle(index: number, count: number): CSSProperties {
  const share = `((100% - ${8 + 4 * (count - 1)}px) / ${count})`;
  return {
    width: `calc${share}`,
    insetInlineStart: `calc(4px + ${index} * (${share} + 4px))`,
  };
}

export function Stat({
  label,
  value,
  tone,
  dir,
}: {
  label: string;
  value: string;
  tone?: "ok" | "bad";
  dir?: "ltr";
}) {
  return (
    <div className="flex-1 min-w-0 px-2.5 py-1.5 border-s border-border/30 first:border-s-0">
      <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground truncate">
        {label}
      </div>
      <div
        className={cn(
          "mt-0.5 font-mono text-[13px] font-medium tabular-nums leading-tight truncate",
          tone === "ok" && "text-[#5f6f2f] dark:text-[#b4c785]",
          tone === "bad" && "text-[#a85a3b] dark:text-[#fba584]",
        )}
        title={value}
        dir={dir}
      >
        {value}
      </div>
    </div>
  );
}
