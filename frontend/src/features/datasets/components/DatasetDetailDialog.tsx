"use client";

import { LoadingState } from "@/shared/ui/loading-state";
import { CountPill } from "@/shared/ui/count-badge";
import { DatasetRowsView } from "./DatasetRowsView";
import { ExpandTableButton } from "./DatasetPreviewPanel";
import * as React from "react";
import Link from "next/link";
import { ArrowUpRight, Sparkle, Table as Table2 } from "@/shared/ui/icons";
import { Segmented } from "@/shared/ui/segmented";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/shared/ui/primitives/dialog";
import { StatusBadge } from "@/shared/ui/status-badge";
import { EmptyState } from "@/shared/ui/empty-state";
import { FadeIn } from "@/shared/ui/motion";
import {
  getDatasetRows,
  listDatasetOptimizations,
  type DatasetOptimizationRef,
  type DatasetRowsResponse,
  type DatasetSummary,
} from "@/shared/lib/api";
import { formatMsg, msg } from "@/shared/lib/messages";
import { formatRelativeTime } from "@/shared/lib/formatters";
import { cn } from "@/shared/lib/utils";

// Mirrors the Explore corpus toggle so the sliding pill feels identical app-wide.

type DetailTab = "rows" | "usage";

/**
 * Read-only detail sheet for one library dataset, split by a sliding segmented
 * toggle into two views: an interactive row grid (sort / per-column filter /
 * resize / click-to-copy, the same excel-filter toolkit the optimization Data
 * tab uses) and the reverse link — every optimization the caller can see that
 * was submitted from this dataset. Driven open by the parent (a card click or
 * the ``?open=`` deep-link from an optimization's source link).
 */
export function DatasetDetailDialog({
  dataset,
  onClose,
}: {
  dataset: DatasetSummary | null;
  onClose: () => void;
}) {
  const [rows, setRows] = React.useState<DatasetRowsResponse | null>(null);
  const [optimizations, setOptimizations] = React.useState<DatasetOptimizationRef[] | null>(null);
  const [tab, setTab] = React.useState<DetailTab>("rows");
  // Index into the filtered row order; non-null swaps the grid for the reader.
  const [readerIndex, setReaderIndex] = React.useState<number | null>(null);
  const [expanded, setExpanded] = React.useState(false);
  const expandButton = React.useRef<HTMLButtonElement>(null);
  const datasetId = dataset?.id ?? null;

  React.useEffect(() => {
    if (!datasetId) return;
    let cancelled = false;
    setRows(null);
    setOptimizations(null);
    setTab("rows");
    setReaderIndex(null);
    setExpanded(false);
    getDatasetRows(datasetId)
      .then((res) => !cancelled && setRows(res))
      .catch(
        () =>
          !cancelled &&
          setRows({ id: datasetId, columns: [], rows: [], row_count: 0, column_schema: {} }),
      );
    listDatasetOptimizations(datasetId)
      .then((res) => !cancelled && setOptimizations(res.optimizations))
      .catch(() => !cancelled && setOptimizations([]));
    return () => {
      cancelled = true;
    };
  }, [datasetId]);

  const usageCount = optimizations?.length ?? 0;

  const segments: ReadonlyArray<{ value: DetailTab; label: string; icon: typeof Table2 }> = [
    { value: "rows", label: msg("datasets.detail.rows_title"), icon: Table2 },
    { value: "usage", label: msg("datasets.detail.tab.usage"), icon: Sparkle },
  ];

  return (
    <Dialog open={dataset !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        className={cn(
          "overflow-hidden p-0 transition-[max-width] duration-200 ease-out motion-reduce:transition-none",
          expanded
            ? "max-w-[96vw] sm:max-w-[96vw]"
            : "max-w-[min(72rem,94vw)] sm:max-w-[min(72rem,94vw)]",
        )}
        aria-describedby={undefined}
        onEscapeKeyDown={(e) => {
          // Escape peels one layer at a time: reader, expansion, dialog.
          if (readerIndex !== null) {
            e.preventDefault();
            setReaderIndex(null);
          } else if (expanded && tab === "rows") {
            e.preventDefault();
            setExpanded(false);
            expandButton.current?.focus();
          }
        }}
      >
        <div
          className={cn("flex flex-col", expanded && tab === "rows" ? "h-[94dvh]" : "max-h-[85vh]")}
        >
          <DialogHeader className="shrink-0 px-4 pb-4 pt-6 sm:px-6">
            <DialogTitle className="truncate">{dataset?.name}</DialogTitle>
          </DialogHeader>

          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 justify-center border-b border-border/40 px-4 pb-4 sm:px-6">
              <Segmented
                size="sm"
                label={msg("datasets.detail.view_aria")}
                value={tab}
                onChange={(value) => {
                  if (value !== tab) setTab(value);
                }}
                options={segments.map((seg) => {
                  const Icon = seg.icon;
                  return {
                    value: seg.value,
                    label: seg.label,
                    icon: <Icon className="size-3.5" aria-hidden="true" />,
                    trailing:
                      seg.value === "usage" && usageCount > 0 ? (
                        <CountPill>{usageCount}</CountPill>
                      ) : undefined,
                  };
                })}
              />
            </div>

            <div className={tab === "rows" ? "contents" : "hidden"}>
              <DatasetRowsView
                rows={rows}
                filename={dataset?.name}
                readerIndex={readerIndex}
                setReaderIndex={setReaderIndex}
                toolbarLeading={
                  dataset &&
                  `${formatMsg("datasets.count.rows", { count: dataset.row_count })} · ${formatMsg("datasets.count.columns", { count: dataset.column_count })}`
                }
                toolbarActions={
                  <ExpandTableButton
                    ref={expandButton}
                    expanded={expanded}
                    onToggle={() => setExpanded(!expanded)}
                  />
                }
              />
            </div>
            {tab !== "rows" && (
              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
                {optimizations === null ? (
                  <LoadingState
                    srLabel={msg("datasets.detail.loading")}
                    className="min-h-40 flex-1"
                  />
                ) : optimizations.length === 0 ? (
                  <div className="py-8">
                    <EmptyState
                      variant="list"
                      icon={Sparkle}
                      title={msg("datasets.detail.used_by_empty")}
                    />
                  </div>
                ) : (
                  <FadeIn>
                    <ul className="divide-y divide-border/40 rounded-lg border border-border/50">
                      {optimizations.map((opt) => (
                        <li key={opt.optimization_id}>
                          <Link
                            href={`/optimizations/${opt.optimization_id}`}
                            className="group/link flex min-h-[44px] items-center gap-3 px-3 py-2.5 transition-colors hover:bg-accent/40"
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
                  </FadeIn>
                )}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
