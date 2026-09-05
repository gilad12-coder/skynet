"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import { ArrowsIn, ArrowsOut } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import { msg } from "@/shared/lib/messages";
import { DatasetRowsView } from "@/features/datasets";
import type { ParsedDataset } from "@/shared/lib/parse-dataset";

export function DatasetPreviewLayout({
  data,
  filename,
  open,
  onOpenChange,
  expanded,
  onExpandedChange,
  children,
}: {
  data: ParsedDataset | null;
  filename?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  children: ReactNode;
}) {
  const id = useId();
  const expandButton = useRef<HTMLButtonElement>(null);
  const [readerIndex, setReaderIndex] = useState<number | null>(null);
  const visible = Boolean(data && open);
  return (
    <div className="min-w-0 space-y-4">
      {data && (
        <div className="flex flex-wrap items-center gap-3">
          <div
            className="relative grid min-w-0 flex-1 gap-1 rounded-lg bg-muted p-1"
            role="group"
            aria-label={msg("datasets.detail.view_aria")}
            style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}
          >
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-1 w-[calc(50%-6px)] rounded-md bg-background shadow-sm transition-[inset-inline-start] duration-150 ease-out motion-reduce:transition-none"
              style={{ insetInlineStart: visible ? "calc(50% + 2px)" : 4 }}
            />
            {[false, true].map((preview) => (
              <button
                key={String(preview)}
                type="button"
                aria-pressed={visible === preview}
                aria-controls={id}
                onClick={() => {
                  onOpenChange(preview);
                  if (!preview) onExpandedChange(false);
                }}
                className={`relative z-10 min-h-11 min-w-0 cursor-pointer rounded-md px-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring ${visible === preview ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                {msg(
                  preview
                    ? "optimization.blackbox.versions.view.preview"
                    : "submit.blackbox.cases.upload",
                )}
              </button>
            ))}
          </div>
          {visible && (
            <Button
              ref={expandButton}
              type="button"
              variant="ghost"
              className="min-h-11 gap-2"
              aria-expanded={expanded}
              aria-controls={id}
              onClick={() => onExpandedChange(!expanded)}
            >
              {expanded ? <ArrowsIn className="size-4" /> : <ArrowsOut className="size-4" />}
              {msg(
                expanded
                  ? "shared.expandable_textarea.collapse"
                  : "shared.expandable_textarea.expand",
              )}
            </Button>
          )}
        </div>
      )}
      <div
        id={id}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !visible) return;
          if (readerIndex !== null) {
            event.preventDefault();
            setReaderIndex(null);
          } else if (expanded) {
            event.preventDefault();
            onExpandedChange(false);
            expandButton.current?.focus();
          }
        }}
      >
        <div className={visible ? "hidden" : "space-y-5"}>{children}</div>
        {data && (
          <div
            className={
              visible
                ? `flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-border ${expanded ? "h-[70dvh] min-h-96" : "h-96"}`
                : "hidden"
            }
          >
            <DatasetRowsView
              rows={data}
              filename={filename ?? undefined}
              readerIndex={readerIndex}
              setReaderIndex={setReaderIndex}
            />
          </div>
        )}
      </div>
    </div>
  );
}
