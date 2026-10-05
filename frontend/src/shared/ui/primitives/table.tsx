"use client";

import * as React from "react";

import { cn } from "@/shared/lib/utils";
import { CaretDown } from "@/shared/ui/icons";

/**
 * Container width below which a column folds into its row's primary cell.
 * ``sm`` < 32rem, ``md`` < 44rem, ``lg`` < 60rem (see globals.css).
 */
type TableCollapse = "sm" | "md" | "lg";

function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div data-slot="table-container" className="relative w-full overflow-x-auto">
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn(
        "sticky top-0 z-10 bg-muted/40 backdrop-blur-sm [&_tr]:border-b [&_tr]:border-border/60",
        className,
      )}
      {...props}
    />
  );
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn("border-b border-border/60 data-[state=selected]:bg-primary/[0.08]", className)}
      {...props}
    />
  );
}

function TableHead({
  className,
  scope = "col",
  collapse,
  ...props
}: React.ComponentProps<"th"> & { collapse?: TableCollapse }) {
  return (
    <th
      data-slot="table-head"
      data-collapse={collapse}
      scope={scope}
      className={cn(
        "h-12 px-2 text-start align-middle text-[0.75rem] font-semibold whitespace-nowrap text-muted-foreground [&:has([role=checkbox])]:pe-0 [&>[role=checkbox]]:translate-y-[2px]",
        className,
      )}
      {...props}
    />
  );
}

function TableCell({
  className,
  collapse,
  ...props
}: React.ComponentProps<"td"> & { collapse?: TableCollapse }) {
  // ``overflow-hidden text-ellipsis`` (+ the existing ``whitespace-nowrap``)
  // makes every cell width-truncate dynamically — when the caller sets a
  // ``max-w-*`` on the cell, overflowing content gets the ``…`` rendered
  // by the browser at the exact column boundary instead of by a manual
  // ``slice(0, N)`` upstream. Cells that need to wrap (long copy, code
  // blocks) opt in with ``whitespace-normal break-words``; cells with no
  // ``max-w`` simply expand to content and never overflow.
  return (
    <td
      data-slot="table-cell"
      data-collapse={collapse}
      className={cn(
        "p-2.5 align-middle whitespace-nowrap overflow-hidden text-ellipsis [&:has([role=checkbox])]:pe-0 [&>[role=checkbox]]:translate-y-[2px]",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The folded copy of a ``collapse`` column, placed inside the row's primary
 * cell. It stays hidden while the column has room and glides in when the
 * table narrows past the same breakpoint, so no value is lost.
 */
function TableInline({
  className,
  at,
  ...props
}: React.ComponentProps<"span"> & { at: TableCollapse }) {
  return (
    <span
      data-slot="table-inline"
      data-at={at}
      className={cn(
        "items-center gap-1 text-xs text-muted-foreground tabular-nums shrink-0",
        className,
      )}
      {...props}
    />
  );
}

/**
 * A collapsible group of rows with a header row showing the group's label
 * and count. Pass the table's column count as ``colSpan``.
 */
function TableGroup({
  label,
  count,
  icon,
  colSpan,
  defaultOpen = true,
  children,
}: {
  label: React.ReactNode;
  count?: number;
  icon?: React.ReactNode;
  colSpan: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <tbody data-slot="table-group" data-state={open ? "open" : "closed"}>
      <tr data-slot="table-group-header" className="border-b border-border/60 bg-muted/30">
        <th scope="rowgroup" colSpan={colSpan} className="p-0 text-start font-normal">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="flex h-8 w-full cursor-pointer items-center gap-2 px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
          >
            {icon}
            <span>{label}</span>
            {count !== undefined && (
              <span className="text-muted-foreground tabular-nums">{count}</span>
            )}
            <CaretDown
              aria-hidden="true"
              className="ms-auto size-3 text-muted-foreground transition-transform duration-200 in-data-[state=closed]:-rotate-90"
            />
          </button>
        </th>
      </tr>
      {open && children}
    </tbody>
  );
}

export {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
  TableInline,
  TableGroup,
  type TableCollapse,
};
