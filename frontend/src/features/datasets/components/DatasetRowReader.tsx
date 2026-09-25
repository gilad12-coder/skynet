"use client";
import * as React from "react";
import { toast } from "react-toastify";
import { ArrowLeft, CaretLeft, CaretRight } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import { CopyButton } from "@/shared/ui/copy-button";
import { FadeIn } from "@/shared/ui/motion";
import { formatMsg, msg } from "@/shared/lib/messages";
import { getActiveDir } from "@/shared/lib/runtime-locale";
import { arrowPageStep } from "@/shared/lib/arrow-paging";
import { isImageDataUri, readerText } from "./dataset-cells";

/**
 * Full-record reader for one dataset row: every column stacked with its whole
 * value, a copy button per field, and prev/next stepping by button or arrow
 * key. Shared by every dataset preview so a double-click (or a tap on touch)
 * opens the same view everywhere.
 */
export function DatasetRowReader({
  columns,
  row,
  index,
  total,
  onStep,
  onClose,
}: {
  columns: string[];
  row: Record<string, unknown>;
  index: number;
  total: number;
  onStep: (delta: number) => void;
  onClose: () => void;
}) {
  const readerRef = React.useRef<HTMLDivElement>(null);

  // The reader owns Arrow-key row navigation while it is open; focus lands on
  // its container so the keys work without clicking anything first.
  React.useEffect(() => {
    readerRef.current?.focus({ preventScroll: true });
  }, [index]);

  const counter = formatMsg("datasets.detail.row_reader.counter", { index: index + 1, total });

  return (
    <div
      ref={readerRef}
      tabIndex={-1}
      role="group"
      aria-label={counter}
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
        onStep(step);
      }}
    >
      <div className="mb-3 flex shrink-0 items-center gap-2">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          className="max-lg:size-[44px]"
          aria-label={msg("datasets.detail.row_reader.back")}
        >
          <ArrowLeft className="size-4 rtl:rotate-180" />
        </Button>
        <div className="ms-auto flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => onStep(-1)}
            disabled={index === 0}
            className="size-[44px] lg:size-8"
            aria-label={msg("datasets.detail.row_reader.prev")}
          >
            <CaretLeft className="size-4 rtl:rotate-180" />
          </Button>
          <span className="text-xs text-muted-foreground tabular-nums">{counter}</span>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => onStep(1)}
            disabled={index >= total - 1}
            className="size-[44px] lg:size-8"
            aria-label={msg("datasets.detail.row_reader.next")}
          >
            <CaretRight className="size-4 rtl:rotate-180" />
          </Button>
        </div>
      </div>
      <FadeIn key={index} className="min-h-0 flex-1 overflow-y-auto pe-1">
        <dl className="flex flex-col gap-4 pb-2">
          {columns.map((col) => {
            const raw = row[col];
            const value = readerText(raw);
            const image = isImageDataUri(raw);
            const structured = raw != null && typeof raw !== "string";
            return (
              <div key={col} className="group/field">
                <div className="mb-1.5 flex items-center gap-2">
                  <dt className="text-[0.6875rem] font-semibold tracking-wide text-muted-foreground uppercase">
                    {col}
                  </dt>
                  {!image && (
                    <CopyButton
                      text={value}
                      ariaLabel={formatMsg("datasets.detail.row_reader.copy_field", {
                        column: col,
                      })}
                      onCopied={() => toast.success(msg("clipboard.copied"))}
                      onCopyError={() => toast.error(msg("clipboard.copy_failed"))}
                      className="opacity-100 transition-opacity lg:opacity-0 lg:group-hover/field:opacity-100 lg:focus-visible:opacity-100"
                    />
                  )}
                </div>
                <dd
                  dir="auto"
                  className={`rounded-lg border border-border/50 bg-muted/20 px-3.5 py-2.5 break-words whitespace-pre-wrap ${
                    structured
                      ? "font-mono text-xs leading-5 text-foreground/80"
                      : "text-[0.8125rem] leading-6 text-foreground/90"
                  }`}
                >
                  {image ? (
                    <img src={raw} alt={col} className="max-h-72 rounded-md object-contain" />
                  ) : (
                    value || <span className="text-muted-foreground">—</span>
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      </FadeIn>
    </div>
  );
}
