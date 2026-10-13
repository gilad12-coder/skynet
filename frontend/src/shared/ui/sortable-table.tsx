"use client";

import { useMemo } from "react";
import type { ReactNode } from "react";
import { useTableSort } from "@/shared/hooks/use-table-sort";
import { msg } from "@/shared/lib/messages";
import { cn } from "@/shared/lib/utils";
import {
  ColumnHeader,
  ResetColumnsButton,
  ResetFiltersButton,
  useColumnFilters,
  useColumnResize,
} from "@/shared/ui/excel-filter";
import type { SortDir } from "@/shared/ui/excel-filter";
import { ExportTableMenu } from "@/shared/ui/export-table-menu";
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/shared/ui/primitives/table";

// Same density overrides as the optimizations table (JobsTab) so every
// analytics table reads as one table family.
const TABLE_CLASS =
  "no-copy-underline [&_thead_th]:ps-1 [&_thead_th]:pe-2 [&_thead_th]:py-2 [&_thead_th]:text-[0.6875rem] [&_thead_th_button]:px-1 [&_thead_svg]:size-2.5 [&_tbody_td]:px-1.5";

function compare(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

/** Sort a copy of `rows` by `key`; nulls always sort last. */
export function sortRows<T>(rows: T[], key: keyof T, dir: SortDir): T[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => sign * compare(a[key], b[key]));
}

/** Row count, reset-filters, reset-columns and export controls above a table. */
export function Toolbar({
  count,
  filters,
  resize,
  exportData,
}: {
  count: number;
  filters: { activeCount: number; clearAll: () => void };
  resize: ReturnType<typeof useColumnResize>;
  exportData: () => { columns: string[]; rows: Array<Record<string, unknown>>; filename: string };
}) {
  return (
    <div className="mb-3 flex min-h-[44px] items-center gap-2 max-lg:[&_button]:size-[44px] lg:min-h-0">
      <span className="text-xs text-muted-foreground tabular-nums">
        {count}
        {msg("auto.features.dashboard.components.jobstab.3")}
      </span>
      <ResetFiltersButton filters={filters} />
      <ResetColumnsButton resize={resize} />
      {count > 0 && <ExportTableMenu iconOnly className="ms-auto" getData={exportData} />}
    </div>
  );
}

export function TableFrame({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-border/40 bg-card/60">
      <Table className={TABLE_CLASS}>{children}</Table>
    </div>
  );
}

export function EmptyRow({ colSpan }: { colSpan: number }) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="py-6 text-center text-sm text-muted-foreground">
        {msg("auto.shared.charts.chart.utils.literal.1")}
      </TableCell>
    </TableRow>
  );
}

type Primitive = string | number | null;

export interface SortableColumn<R> {
  key: keyof R & string;
  label: string;
  width?: number;
  /** Offer an Excel-style value filter on this column. */
  filter?: boolean;
  /** Cell content; defaults to the raw value. */
  render?: (row: R) => ReactNode;
  /** Cell text direction, e.g. `ltr` for identifiers inside an RTL page. */
  dir?: "ltr" | "rtl";
  className?: string;
}

/**
 * A read-only table on the analytics table stack (sortable and filterable
 * headers, resizable columns, CSV/JSON export) for rows that need no custom
 * row behaviour.
 */
export function SortableTable<R extends Record<string, Primitive>>({
  rows,
  columns,
  rowKey,
  exportName,
  initialSort = "",
  initialDir = "asc",
}: {
  rows: R[];
  columns: ReadonlyArray<SortableColumn<R>>;
  rowKey: (row: R) => string;
  exportName: string;
  /** Column the table starts sorted by; empty keeps the data's own order. */
  initialSort?: string;
  initialDir?: "asc" | "desc";
}) {
  const { sortKey, sortDir, toggleSort } = useTableSort<string>(initialSort, initialDir);
  const columnFilters = useColumnFilters();
  const resize = useColumnResize();
  const { filters, setColumnFilter, openFilter, setOpenFilter } = columnFilters;

  const options = useMemo(() => {
    const out: Record<string, Array<{ value: string; label: string }>> = {};
    for (const column of columns) {
      if (!column.filter) continue;
      out[column.key] = [...new Set(rows.map((row) => String(row[column.key] ?? "")))]
        .filter(Boolean)
        .sort()
        .map((value) => ({ value, label: value }));
    }
    return out;
  }, [rows, columns]);

  const visible = useMemo(() => {
    const kept = rows.filter((row) =>
      columns.every((column) => {
        const active = filters[column.key];
        return !active || active.size === 0 || active.has(String(row[column.key] ?? ""));
      }),
    );
    const known = columns.some((column) => column.key === sortKey);
    return known ? sortRows(kept, sortKey as keyof R, sortDir) : kept;
  }, [rows, columns, filters, sortKey, sortDir]);

  return (
    <div>
      <Toolbar
        count={visible.length}
        filters={columnFilters}
        resize={resize}
        exportData={() => ({
          columns: columns.map((column) => column.key),
          rows: visible.map((row) =>
            Object.fromEntries(columns.map((column) => [column.key, row[column.key]])),
          ),
          filename: exportName,
        })}
      />
      <TableFrame>
        <TableHeader>
          <TableRow>
            {columns.map((column) => (
              <ColumnHeader
                key={column.key}
                label={column.label}
                sortKey={column.key}
                currentSort={sortKey}
                sortDir={sortDir}
                onSort={toggleSort}
                filterCol={column.filter ? column.key : undefined}
                filterOptions={column.filter ? options[column.key] : undefined}
                filters={column.filter ? filters : undefined}
                onFilter={column.filter ? setColumnFilter : undefined}
                openFilter={openFilter}
                setOpenFilter={setOpenFilter}
                width={resize.widths[column.key] ?? column.width}
                onResize={resize.setColumnWidth}
              />
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.length === 0 && <EmptyRow colSpan={columns.length} />}
          {visible.map((row) => (
            <TableRow key={rowKey(row)} className="border-border/30">
              {columns.map((column) => (
                <TableCell
                  key={column.key}
                  className={cn("px-2 tabular-nums", column.className)}
                  data-label={column.label}
                  dir={column.dir}
                >
                  {column.render ? column.render(row) : (row[column.key] ?? "—")}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </TableFrame>
    </div>
  );
}
