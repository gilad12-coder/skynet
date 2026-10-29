"use client";

import * as React from "react";
import Link from "next/link";
import { Dialog, DialogContent } from "@/shared/ui/primitives/dialog";
import { DialogTitleRow } from "@/shared/ui/dialog-title-row";
import { Button } from "@/shared/ui/primitives/button";
import { formatMsg, msg } from "@/shared/lib/messages";
import { formatStorageSize } from "@/shared/lib/formatters";
import type { StorageUsageResponse } from "@/shared/lib/api";
import { cn } from "@/shared/lib/utils";
import { categoryLabel, categoryMeta } from "../lib/categories";
import { StackedUsageBar } from "./StackedUsageBar";

/** Inputs for the presentational quota modal; data is fetched by the host. */
interface StorageQuotaModalProps {
  open: boolean;
  usage: StorageUsageResponse | null;
  loading: boolean;
  onClose: () => void;
}

/**
 * The account-wide storage budget modal: a usage meter, a per-category
 * breakdown of where the space went, and links to the two places a user frees
 * it. Presentational — the host owns the open state and the usage fetch.
 */
export function StorageQuotaModal({ open, usage, loading, onClose }: StorageQuotaModalProps) {
  const usedBytes = usage?.used_bytes ?? 0;
  const quotaBytes = usage?.quota_bytes ?? 0;

  const rows = React.useMemo(() => {
    if (!usage) return [];
    return Object.entries(usage.breakdown)
      .filter(([, bytes]) => bytes > 0)
      .map(([key, bytes]) => ({ key, bytes }))
      .sort((a, b) => b.bytes - a.bytes);
  }, [usage]);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="w-[min(28rem,92vw)] max-w-[min(28rem,92vw)] sm:max-w-md">
        <DialogTitleRow
          title={msg("storage.quota.title")}
          description={msg("storage.quota.body")}
        />

        <div>
          <StackedUsageBar rows={rows} quota={quotaBytes} />
          <p className="mt-1.5 text-end text-xs text-muted-foreground tabular-nums">
            {formatMsg("storage.quota.usage", {
              used: formatStorageSize(usedBytes),
              total: formatStorageSize(quotaBytes),
            })}
          </p>
        </div>

        {(loading || rows.length > 0) && (
          <div>
            <h3 className="mb-2 text-sm font-medium text-foreground">
              {msg("storage.quota.breakdown_title")}
            </h3>
            {loading ? (
              <p className="text-sm text-muted-foreground">{msg("storage.quota.loading")}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {rows.map(({ key, bytes }) => (
                  <li key={key} className="flex items-center gap-2 text-sm">
                    <span
                      className={cn(
                        "size-2 shrink-0 rounded-full",
                        categoryMeta(key)?.swatch ?? "bg-border",
                      )}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate text-foreground">
                      {categoryLabel(key)}
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                      {formatStorageSize(bytes)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <Button asChild onClick={onClose} className="w-full">
          <Link href="/storage">{msg("storage.quota.cta.manage")}</Link>
        </Button>
      </DialogContent>
    </Dialog>
  );
}
