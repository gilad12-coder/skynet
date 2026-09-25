"use client";
import * as React from "react";
import { toast } from "react-toastify";
import { CircleNotch, Tray } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/primitives/tooltip";
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/shared/ui/primitives/table";
import {
  ColumnHeader,
  ResetColumnsButton,
  ResetFiltersButton,
  useColumnFilters,
  useColumnResize,
  type SortDir,
} from "@/shared/ui/excel-filter";
import { EmptyState } from "@/shared/ui/empty-state";
import { ExportTableMenu } from "@/shared/ui/export-table-menu";
import { FadeIn } from "@/shared/ui/motion";
import { formatMsg, msg } from "@/shared/lib/messages";
import type { ParsedDataset } from "@/shared/lib/parse-dataset";
import { DatasetRowReader } from "./DatasetRowReader";
import { cellText, isImageDataUri } from "./dataset-cells";
const RENDER_ROW_CAP = 200;

export function DatasetRowsView({
  rows,
  filename,
  readerIndex,
  setReaderIndex,
  toolbarActions,
  emptyTitle,
}: {
  rows: Pick<ParsedDataset, "columns" | "rows"> | null;
  filename?: string;
  toolbarActions?: React.ReactNode;
  /** Replaces the generic "no rows" message when the dataset itself is empty. */
  emptyTitle?: string;
  readerIndex: number | null;
  setReaderIndex: React.Dispatch<React.SetStateAction<number | null>>;
}) {
  const colFilters = useColumnFilters();
  const colResize = useColumnResize();
  const [sortKey, setSortKey] = React.useState("");
  const [sortDir, setSortDir] = React.useState<SortDir>("asc");
  const { clearAll: clearFilters } = colFilters;
  const { resetAll: resetWidths } = colResize;

  React.useEffect(() => {
    setReaderIndex(null);
    setSortKey("");
    setSortDir("asc");
    clearFilters();
    resetWidths();
  }, [rows, setReaderIndex, clearFilters, resetWidths]);
  const columns = rows?.columns ?? [];
  const allRows = React.useMemo(() => rows?.rows ?? [], [rows]);

  const toggleSort = (key: string) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const filtered = React.useMemo(() => {
    let result = allRows.filter((r) => {
      for (const [col, allowed] of Object.entries(colFilters.filters)) {
        if (allowed.size === 0) continue;
        if (!allowed.has(cellText(r[col]))) return false;
      }
      return true;
    });
    if (sortKey) {
      result = [...result].sort((a, b) => {
        const cmp = cellText(a[sortKey]).localeCompare(cellText(b[sortKey]), "he", {
          numeric: true,
        });
        return sortDir === "asc" ? cmp : -cmp;
      });
    }
    return result;
  }, [allRows, colFilters.filters, sortKey, sortDir]);

  const filterOptions = React.useMemo(() => {
    const opts: Record<string, Array<{ value: string; label: string }>> = {};
    for (const col of columns) {
      const vals = [...new Set(allRows.map((r) => cellText(r[col])))].filter(Boolean).sort();
      opts[col] = vals.map((v) => ({ value: v, label: v.length > 40 ? `${v.slice(0, 40)}…` : v }));
    }
    return opts;
  }, [allRows, columns]);

  const copyValue = React.useCallback((text: string) => {
    if (!text) return;
    navigator.clipboard
      .writeText(text)
      .then(() => toast.success(msg("clipboard.copied")))
      .catch(() => toast.error(msg("clipboard.copy_failed")));
  }, []);

  // A cell's single click copies its value, but the same spot double-clicked
  // opens the row reader — so the copy waits long enough to know no second
  // click is coming, and the double-click handler cancels it.
  const pendingCopy = React.useRef<number | null>(null);
  const cancelPendingCopy = React.useCallback(() => {
    if (pendingCopy.current !== null) {
      window.clearTimeout(pendingCopy.current);
      pendingCopy.current = null;
    }
  }, []);
  const scheduleCellCopy = React.useCallback(
    (text: string) => {
      cancelPendingCopy();
      pendingCopy.current = window.setTimeout(() => {
        pendingCopy.current = null;
        copyValue(text);
      }, 250);
    },
    [cancelPendingCopy, copyValue],
  );
  React.useEffect(() => cancelPendingCopy, [cancelPendingCopy]);

  const readerRow = readerIndex === null ? null : (filtered[readerIndex] ?? null);

  const stepReader = React.useCallback(
    (delta: number) => {
      setReaderIndex((cur) => {
        if (cur === null) return cur;
        const next = cur + delta;
        return next < 0 || next >= filtered.length ? cur : next;
      });
    },
    [filtered.length, setReaderIndex],
  );

  return (
    <>
      {readerRow !== null && readerIndex !== null ? (
        <DatasetRowReader
          columns={columns}
          row={readerRow}
          index={readerIndex}
          total={filtered.length}
          onStep={stepReader}
          onClose={() => setReaderIndex(null)}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 py-4 sm:px-6">
          {rows === null ? (
            <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
              <CircleNotch className="size-4 animate-spin" />
              {msg("datasets.detail.loading")}
            </div>
          ) : columns.length === 0 || allRows.length === 0 ? (
            <div className="py-8">
              <EmptyState
                variant="list"
                icon={Tray}
                title={emptyTitle ?? msg("datasets.detail.rows_empty")}
              />
            </div>
          ) : (
            <FadeIn className="flex min-h-0 flex-1 flex-col">
              <div className="mb-2 flex min-h-[44px] items-center justify-end gap-3 max-lg:[&_button]:size-[44px] lg:min-h-0">
                <div className="flex items-center gap-2 shrink-0">
                  <ResetFiltersButton filters={colFilters} />
                  <ResetColumnsButton resize={colResize} />
                  <ExportTableMenu
                    iconOnly
                    disabled={filtered.length === 0}
                    getData={() => ({
                      columns,
                      rows: filtered.map((row) =>
                        Object.fromEntries(columns.map((col) => [col, row[col]])),
                      ),
                      filename: filename || "dataset",
                    })}
                  />
                  {toolbarActions}
                </div>
              </div>
              {filtered.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border/60 py-8">
                  <EmptyState
                    variant="list"
                    icon={Tray}
                    title={msg("datasets.detail.rows_empty")}
                  />
                </div>
              ) : (
                <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border/50">
                  {/* Per-column width floor: on narrow viewports the
                            fixed-layout table scrolls sideways (the Table
                            container is overflow-x-auto) instead of crushing
                            every column to an unreadable sliver. */}
                  <Table
                    className="table-fixed max-lg:[&_thead_th]:py-0 max-lg:[&_thead_th_div]:min-h-[44px] max-lg:[&_thead_button]:min-h-[44px] max-lg:[&_thead_button]:min-w-[44px]"
                    style={{ minWidth: `${columns.length * 6}rem` }}
                  >
                    <TableHeader>
                      <TableRow>
                        {columns.map((col) => (
                          <ColumnHeader
                            key={col}
                            label={col}
                            sortKey={col}
                            currentSort={sortKey}
                            sortDir={sortDir}
                            onSort={toggleSort}
                            filterCol={col}
                            filterOptions={filterOptions[col] ?? []}
                            filters={colFilters.filters}
                            onFilter={colFilters.setColumnFilter}
                            openFilter={colFilters.openFilter}
                            setOpenFilter={colFilters.setOpenFilter}
                            width={colResize.widths[col]}
                            onResize={colResize.setColumnWidth}
                          />
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filtered.slice(0, RENDER_ROW_CAP).map((row, i) => (
                        <Tooltip key={i} delayDuration={500}>
                          <TooltipTrigger asChild>
                            <TableRow
                              className="cursor-pointer transition-colors hover:bg-muted/40"
                              onClick={() => {
                                if (!window.matchMedia("(any-pointer: coarse)").matches) return;
                                cancelPendingCopy();
                                setReaderIndex(i);
                              }}
                              onDoubleClick={() => {
                                cancelPendingCopy();
                                setReaderIndex(i);
                              }}
                            >
                              {columns.map((col) => (
                                <TableCell
                                  key={col}
                                  className="max-w-[280px] align-top text-xs text-foreground/80"
                                  style={
                                    colResize.widths[col]
                                      ? {
                                          width: colResize.widths[col],
                                          maxWidth: colResize.widths[col],
                                        }
                                      : undefined
                                  }
                                  title={isImageDataUri(row[col]) ? undefined : cellText(row[col])}
                                  onClick={(e) => {
                                    if (e.detail !== 1 || isImageDataUri(row[col])) return;
                                    scheduleCellCopy(cellText(row[col]));
                                  }}
                                >
                                  {isImageDataUri(row[col]) ? (
                                    <img
                                      src={row[col] as string}
                                      alt=""
                                      loading="lazy"
                                      className="size-10 rounded object-cover"
                                    />
                                  ) : (
                                    <span
                                      dir="auto"
                                      className="line-clamp-2 break-words whitespace-normal hover:underline underline-offset-2 decoration-foreground/40"
                                    >
                                      {cellText(row[col])}
                                    </span>
                                  )}
                                </TableCell>
                              ))}
                            </TableRow>
                          </TooltipTrigger>
                          <TooltipContent>{msg("datasets.detail.row_reader.hint")}</TooltipContent>
                        </Tooltip>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
              {filtered.length > RENDER_ROW_CAP && (
                <p className="mt-2 text-center text-[0.625rem] text-muted-foreground">
                  {formatMsg("datasets.detail.rows_more", {
                    shown: RENDER_ROW_CAP,
                    total: filtered.length,
                  })}
                </p>
              )}
            </FadeIn>
          )}
        </div>
      )}
    </>
  );
}
