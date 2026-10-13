"use client";

import Link from "next/link";
import { ArrowUpRight, Sparkle } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/primitives/popover";
import { CountPill } from "@/shared/ui/count-badge";
import { EmptyState } from "@/shared/ui/empty-state";
import { LoadingState } from "@/shared/ui/loading-state";
import { StatusBadge } from "@/shared/ui/status-badge";
import type { DatasetOptimizationRef } from "@/shared/lib/api";
import { msg } from "@/shared/lib/messages";
import { formatRelativeTime } from "@/shared/lib/formatters";

/**
 * Toolbar button on the dataset page listing every optimization the caller can
 * see that was submitted from this dataset — the reverse of an optimization's
 * source-dataset link. ``null`` optimizations means still loading.
 */
export function DatasetUsageButton({
  optimizations,
}: {
  optimizations: DatasetOptimizationRef[] | null;
}) {
  const count = optimizations?.length ?? 0;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground">
          <Sparkle className="size-4" aria-hidden="true" />
          {msg("datasets.detail.tab.usage")}
          {count > 0 && <CountPill>{count}</CountPill>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-1.5">
        {optimizations === null ? (
          <LoadingState srLabel={msg("datasets.detail.loading")} className="min-h-24" />
        ) : optimizations.length === 0 ? (
          <EmptyState variant="list" icon={Sparkle} title={msg("datasets.detail.used_by_empty")} />
        ) : (
          <ul className="max-h-80 overflow-y-auto">
            {optimizations.map((opt) => (
              <li key={opt.optimization_id}>
                <Link
                  href={`/optimizations/${opt.optimization_id}`}
                  className="group/link flex min-h-[40px] items-center gap-2.5 rounded-md px-2.5 py-2 transition-colors hover:bg-accent/40"
                >
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                    {opt.name || opt.optimization_id}
                  </span>
                  {opt.status && <StatusBadge status={opt.status} />}
                  {opt.created_at && (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatRelativeTime(opt.created_at)}
                    </span>
                  )}
                  <ArrowUpRight className="size-4 shrink-0 text-muted-foreground/60 transition-colors group-hover/link:text-foreground" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
