"use client";
import * as React from "react";
import { toast } from "react-toastify";
import { ArrowLeft, CaretLeft, CaretRight, CircleNotch, Tray } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/shared/ui/primitives/table";
import {
  ColumnHeader,
  ResetColumnsButton,
  ResetFiltersButton,
  useColumnFilters,
  useColumnResize,
  type SortDir,
} from "@/shared/ui/excel-filter";
import { CopyButton } from "@/shared/ui/copy-button";
import { EmptyState } from "@/shared/ui/empty-state";
import { ExportTableMenu } from "@/shared/ui/export-table-menu";
import { FadeIn } from "@/shared/ui/motion";
import { formatMsg, msg } from "@/shared/lib/messages";
import { getActiveDir } from "@/shared/lib/runtime-locale";
import { arrowPageStep } from "@/shared/lib/arrow-paging";
import type { ParsedDataset } from "@/shared/lib/parse-dataset";
const RENDER_ROW_CAP = 200;
/** Render any cell value as a short, single-line string for the preview grid. */
function cellText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Render a value for the full-record reader: prose as-is, structures pretty-printed. */
function readerText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function DatasetRowsView({
  rows,
  filename,
  readerIndex,
  setReaderIndex,
  toolbarActions,
}: {
  rows: Pick<ParsedDataset, "columns" | "rows"> | null;
  filename?: string;
  toolbarActions?: React.ReactNode;
  readerIndex: number | null;
  setReaderIndex: React.Dispatch<React.SetStateAction<number | null>>;
}) {
  const readerRef = React.useRef<HTMLDivElement>(null);
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

  // The reader owns Arrow-key row navigation while it is open; focus lands on
  // its container so the keys work without clicking anything first.
  React.useEffect(() => {
    if (readerRow !== null) readerRef.current?.focus({ preventScroll: true });
  }, [readerRow]);

  return (
    <>
      {readerRow !== null && readerIndex !== null ? (
        <div
          ref={readerRef}
          tabIndex={-1}
          role="group"
          aria-label={formatMsg("datasets.detail.row_reader.counter", {
            index: readerIndex + 1,
            total: filtered.length,
          })}
          className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 py-4 focus-visible:outline-none sm:px-6"
          onKeyDown={(e) => {
            // ↑/↓ walk the row list; ←/→ follow the prev/next carets,
            // which mirror in RTL.
            const step =
              e.key === "ArrowUp"
                ? -1
                : e.key === "ArrowDown"
                  ? 1
                  : arrowPageStep(e, getActiveDir() === "rtl");
            if (step === 0) return;
            e.preventDefault();
            stepReader(step);
          }}
        >
          <div className="mb-3 flex shrink-0 items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setReaderIndex(null)}
              className="min-h-[44px] gap-1.5 text-muted-foreground hover:text-foreground lg:min-h-0"
            >
              <ArrowLeft className="size-4 rtl:rotate-180" />
              {msg("datasets.detail.row_reader.back")}
            </Button>
            <div className="ms-auto flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => stepReader(-1)}
                disabled={readerIndex === 0}
                className="size-[44px] lg:size-8"
                aria-label={msg("datasets.detail.row_reader.prev")}
              >
                <CaretLeft className="size-4 rtl:rotate-180" />
              </Button>
              <span className="text-xs text-muted-foreground tabular-nums">
                {formatMsg("datasets.detail.row_reader.counter", {
                  index: readerIndex + 1,
                  total: filtered.length,
                })}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => stepReader(1)}
                disabled={readerIndex >= filtered.length - 1}
                className="size-[44px] lg:size-8"
                aria-label={msg("datasets.detail.row_reader.next")}
              >
                <CaretRight className="size-4 rtl:rotate-180" />
              </Button>
            </div>
          </div>
          <FadeIn key={readerIndex} className="min-h-0 flex-1 overflow-y-auto pe-1">
            <dl className="flex flex-col gap-4 pb-2">
              {columns.map((col) => {
                const value = readerText(readerRow[col]);
                const structured = readerRow[col] != null && typeof readerRow[col] !== "string";
                return (
                  <div key={col} className="group/field">
                    <div className="mb-1.5 flex items-center gap-2">
                      <dt className="text-[0.6875rem] font-semibold tracking-wide text-muted-foreground uppercase">
                        {col}
                      </dt>
                      <CopyButton
                        text={value}
                        ariaLabel={formatMsg("datasets.detail.row_reader.copy_field", {
                          column: col,
                        })}
                        onCopied={() => toast.success(msg("clipboard.copied"))}
                        onCopyError={() => toast.error(msg("clipboard.copy_failed"))}
                        className="opacity-100 transition-opacity lg:opacity-0 lg:group-hover/field:opacity-100 lg:focus-visible:opacity-100"
                      />
                    </div>
                    <dd
                      dir="auto"
                      className={`rounded-lg border border-border/50 bg-muted/20 px-3.5 py-2.5 break-words whitespace-pre-wrap ${
                        structured
                          ? "font-mono text-xs leading-5 text-foreground/80"
                          : "text-[0.8125rem] leading-6 text-foreground/90"
                      }`}
                    >
                      {value || <span className="text-muted-foreground">—</span>}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </FadeIn>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 py-4 sm:px-6">
          {rows === null ? (
            <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
              <CircleNotch className="size-4 animate-spin" />
              {msg("datasets.detail.loading")}
            </div>
          ) : columns.length === 0 || allRows.length === 0 ? (
            <div className="py-8">
              <EmptyState variant="list" icon={Tray} title={msg("datasets.detail.rows_empty")} />
            </div>
          ) : (
            <FadeIn className="flex min-h-0 flex-1 flex-col">
              <div className="mb-2 flex min-h-[44px] items-center justify-between gap-3 max-lg:[&_button]:size-[44px] lg:min-h-0">
                <span className="min-w-0 truncate text-xs text-muted-foreground">
                  {msg("datasets.detail.row_reader.hint")}
                </span>
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
                        <TableRow
                          key={i}
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
                              title={cellText(row[col])}
                              onClick={(e) => {
                                if (e.detail !== 1) return;
                                scheduleCellCopy(cellText(row[col]));
                              }}
                            >
                              <span
                                dir="auto"
                                className="line-clamp-2 break-words whitespace-normal hover:underline underline-offset-2 decoration-foreground/40"
                              >
                                {cellText(row[col])}
                              </span>
                            </TableCell>
                          ))}
                        </TableRow>
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
