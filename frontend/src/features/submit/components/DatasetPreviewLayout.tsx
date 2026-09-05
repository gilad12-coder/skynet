"use client";

import { useId, useRef, type ReactNode } from "react";
import { Eye, X } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import { msg } from "@/shared/lib/messages";
import type { ParsedDataset } from "@/shared/lib/parse-dataset";

export function DatasetPreviewLayout({
  data,
  open,
  onOpenChange,
  children,
}: {
  data: ParsedDataset | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const visible = Boolean(data && open);
  const rows = data?.rows.slice(0, 20) ?? [];
  return (
    <div
      className={
        visible ? "grid min-w-0 gap-6 lg:grid-cols-[minmax(16rem,1fr)_minmax(0,2fr)]" : "min-w-0"
      }
    >
      <div className="min-w-0 space-y-5">
        {children}
        {data && (
          <Button
            type="button"
            variant={visible ? "secondary" : "outline"}
            className="min-h-11 w-full gap-2"
            ref={trigger}
            aria-expanded={visible}
            aria-controls={visible ? id : undefined}
            onClick={() => onOpenChange(!open)}
          >
            <Eye className="size-4" aria-hidden="true" />
            {msg("datasets.detail.view_aria")}
          </Button>
        )}
      </div>
      {visible && data && (
        <section
          id={id}
          aria-label={msg("datasets.detail.view_aria")}
          className="min-w-0 self-start overflow-hidden rounded-xl border border-border bg-background"
        >
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2">
            <div className="min-w-0">
              <p role="heading" aria-level={3} className="text-sm font-medium">
                {msg("datasets.detail.rows_title")}
              </p>
              <p className="text-sm text-muted-foreground">
                {msg("datasets.detail.rows_more", { shown: rows.length, total: data.rowCount })}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-11 shrink-0"
              aria-label={msg("shared.dialog.close")}
              onClick={() => {
                onOpenChange(false);
                trigger.current?.focus();
              }}
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </div>
          <div
            className="max-h-[32rem] overflow-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            tabIndex={0}
            role="region"
            aria-label={msg("datasets.detail.rows_title")}
          >
            <table className="w-full border-collapse text-start text-sm">
              <thead className="sticky top-0 z-10 bg-muted">
                <tr>
                  {data.columns.map((column) => (
                    <th
                      key={column}
                      scope="col"
                      className="border-b border-border px-4 py-3 text-start font-medium"
                    >
                      <span dir="auto">{column}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr
                    key={index}
                    className="border-b border-border/60 last:border-0 hover:bg-muted/30"
                  >
                    {data.columns.map((column) => (
                      <td key={column} className="px-4 py-3 align-top">
                        <div
                          dir="auto"
                          className="max-h-36 min-w-32 max-w-80 overflow-auto whitespace-pre-wrap break-words"
                        >
                          {row[column] == null
                            ? "—"
                            : typeof row[column] === "object"
                              ? JSON.stringify(row[column])
                              : String(row[column])}
                        </div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && (
              <p className="p-4 text-sm text-muted-foreground">
                {msg("datasets.detail.rows_empty")}
              </p>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
