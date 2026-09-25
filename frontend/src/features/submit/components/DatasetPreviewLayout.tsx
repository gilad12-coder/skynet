"use client";

import { useId, type ReactNode } from "react";
import { msg } from "@/shared/lib/messages";
import { Segmented } from "@/shared/ui/segmented";
import { DatasetPreviewPanel } from "@/features/datasets";
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
  const visible = Boolean(data && open);
  return (
    <div className="min-w-0 space-y-4">
      {data && (
        <div className="flex flex-wrap items-center gap-3">
          <Segmented<"upload" | "preview">
            label={msg("datasets.detail.view_aria")}
            className="min-w-0 flex-1"
            controls={id}
            value={visible ? "preview" : "upload"}
            onChange={(v) => {
              const preview = v === "preview";
              onOpenChange(preview);
              if (!preview) onExpandedChange(false);
            }}
            options={[
              { value: "upload", label: msg("submit.blackbox.cases.upload") },
              { value: "preview", label: msg("optimization.blackbox.versions.view.preview") },
            ]}
          />
        </div>
      )}
      <div id={id}>
        <div className={visible ? "hidden" : "space-y-5"}>{children}</div>
        {data && (
          <div className={visible ? undefined : "hidden"}>
            <DatasetPreviewPanel
              rows={data}
              filename={filename ?? undefined}
              expanded={expanded}
              onExpandedChange={onExpandedChange}
            />
          </div>
        )}
      </div>
    </div>
  );
}
