"use client";

import { Books, UploadSimple } from "@/shared/ui/icons";
import { Badge } from "@/shared/ui/primitives/badge";
import { Button } from "@/shared/ui/primitives/button";
import { Separator } from "@/shared/ui/primitives/separator";
import { DatasetPreviewLayout } from "../DatasetPreviewLayout";
import { DatasetPickerDialog } from "@/features/datasets";
import { cn } from "@/shared/lib/utils";
import { formatMsg, msg } from "@/shared/lib/messages";

import type { BlackboxWizardContext } from "../../hooks/use-blackbox-wizard";
import { StepCard } from "./shared";

export function BlackboxCasesStep({
  w,
  previewOpen,
  onPreviewOpenChange,
  previewExpanded,
  onPreviewExpandedChange,
}: {
  w: BlackboxWizardContext;
  previewOpen: boolean;
  onPreviewOpenChange: (open: boolean) => void;
  previewExpanded: boolean;
  onPreviewExpandedChange: (expanded: boolean) => void;
}) {
  const {
    parsedCases,
    casesName,
    handleFileUpload,
    handlePickFromLibrary,
    libraryOpen,
    setLibraryOpen,
    targetKind,
  } = w;

  return (
    <StepCard
      title={msg("submit.blackbox.cases.title")}
      tip={msg("submit.blackbox.cases.none_hint")}
      description={msg(
        targetKind === "agent" ? "submit.blackbox.cases.desc_agent" : "submit.blackbox.cases.desc",
      )}
    >
      <DatasetPreviewLayout
        data={parsedCases}
        filename={casesName}
        expanded={previewExpanded}
        onExpandedChange={onPreviewExpandedChange}
        open={previewOpen}
        onOpenChange={onPreviewOpenChange}
      >
        <label
          className={cn(
            "group relative block cursor-pointer rounded-xl focus-within:ring-2 focus-within:ring-ring border-2 border-dashed text-center transition-colors duration-200",
            parsedCases
              ? "border-primary/40 bg-primary/5 p-4"
              : "p-6 hover:border-primary/50 hover:bg-muted/30 sm:p-10",
          )}
        >
          <UploadSimple className="mx-auto mb-3 h-10 w-10 text-muted-foreground transition-colors duration-300 group-hover:text-primary/70" />
          <p
            className="max-w-full truncate px-4 text-sm font-medium"
            title={casesName || undefined}
          >
            {casesName || msg("submit.blackbox.cases.upload")}
          </p>
          {parsedCases && (
            <Badge variant="secondary" className="mt-2">
              {formatMsg("submit.blackbox.cases.loaded", {
                rows: parsedCases.rowCount,
                cols: parsedCases.columns.length,
              })}
            </Badge>
          )}
          {parsedCases && (
            <span className="mt-3 block text-sm underline underline-offset-4">
              {msg("auto.features.agent.panel.components.datasetuploadcard.replace")}
            </span>
          )}
          <input
            type="file"
            accept=".csv,.json,.xlsx,.xls"
            className="sr-only"
            onChange={handleFileUpload}
          />
        </label>

        <div className="flex items-center gap-3">
          <Separator className="flex-1" />
          <span className="text-xs text-muted-foreground">{msg("submit.dataset.library_or")}</span>
          <Separator className="flex-1" />
        </div>

        <Button
          type="button"
          variant="outline"
          onClick={() => setLibraryOpen(true)}
          className="min-h-[44px] w-full justify-center gap-2 lg:min-h-0"
        >
          <Books className="size-4" />
          {msg("submit.dataset.library_pick")}
        </Button>
      </DatasetPreviewLayout>
      <DatasetPickerDialog
        open={libraryOpen}
        onOpenChange={setLibraryOpen}
        onPick={handlePickFromLibrary}
      />
    </StepCard>
  );
}
