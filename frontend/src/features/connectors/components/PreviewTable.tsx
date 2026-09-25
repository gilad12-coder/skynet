"use client";

import * as React from "react";
import { CircleNotch } from "@/shared/ui/icons";
import type { HubPreview } from "@/shared/lib/api";
import { formatMsg } from "@/shared/lib/messages";
import { cn } from "@/shared/lib/utils";

const PREVIEW_COLUMNS = 6;
const CELL_MAX_CHARS = 80;

/** Render one preview cell: images inline, everything else as clipped text. */
function PreviewCell({ value, isImage }: { value: unknown; isImage: boolean }) {
  if (value == null) return <span className="text-muted-foreground/50">—</span>;
  if (isImage && typeof value === "string" && value.startsWith("data:")) {
    return <img src={value} alt="" className="size-10 rounded object-cover" loading="lazy" />;
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const clipped = text.length > CELL_MAX_CHARS ? `${text.slice(0, CELL_MAX_CHARS)}…` : text;
  return (
    <span
      className="line-clamp-2 break-words"
      title={text.length > CELL_MAX_CHARS ? text : undefined}
    >
      {clipped}
    </span>
  );
}

/** Props for {@link PreviewTable}. */
export interface PreviewTableProps {
  preview: HubPreview | null;
  loading: boolean;
  /** Shown when the preview has no rows. */
  emptyLabel: string;
}

/**
 * The first rows of a remote table, capped to a handful of columns so the
 * dialog stays readable; the rest are counted in a trailing header cell.
 */
export function PreviewTable({ preview, loading, emptyLabel }: PreviewTableProps) {
  const imageColumns = React.useMemo(
    () => new Set((preview?.columns ?? []).filter((c) => /image/i.test(c.type)).map((c) => c.name)),
    [preview],
  );
  const visibleColumns = preview?.columns.slice(0, PREVIEW_COLUMNS) ?? [];
  const hiddenColumnCount = Math.max(0, (preview?.columns.length ?? 0) - PREVIEW_COLUMNS);

  return (
    <div
      dir="ltr"
      className={cn(
        "max-h-[min(16rem,40vh)] overflow-auto rounded-lg border border-border/50",
        loading && "opacity-60",
      )}
    >
      {loading && !preview ? (
        <div className="flex items-center justify-center py-8">
          <CircleNotch className="size-4 animate-spin text-primary" />
        </div>
      ) : !preview || preview.rows.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs text-muted-foreground">{emptyLabel}</p>
      ) : (
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-[#F8F4EF] text-start">
            <tr>
              {visibleColumns.map((c) => (
                <th
                  key={c.name}
                  className="whitespace-nowrap px-2.5 py-1.5 text-start font-medium text-muted-foreground"
                  title={c.type}
                >
                  {c.name}
                </th>
              ))}
              {hiddenColumnCount > 0 && (
                <th className="whitespace-nowrap px-2.5 py-1.5 text-start font-normal text-muted-foreground/70">
                  {formatMsg("hf_import.more_columns", { count: hiddenColumnCount })}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((row, i) => (
              <tr key={i} className="border-t border-border/40 align-top">
                {visibleColumns.map((c) => (
                  <td key={c.name} className="max-w-[16rem] px-2.5 py-1.5">
                    <PreviewCell value={row[c.name]} isImage={imageColumns.has(c.name)} />
                  </td>
                ))}
                {hiddenColumnCount > 0 && <td />}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
