"use client";

import { useState } from "react";
import { Books, UploadSimple } from "@/shared/ui/icons";
import { Badge } from "@/shared/ui/primitives/badge";
import { Button } from "@/shared/ui/primitives/button";
import { Label } from "@/shared/ui/primitives/label";
import { Separator } from "@/shared/ui/primitives/separator";
import { Switch } from "@/shared/ui/primitives/switch";
import { DatasetPreviewLayout } from "../DatasetPreviewLayout";
import { DatasetPickerDialog } from "@/features/datasets";
import { ImportFromMenu } from "@/features/connectors";
import { cn } from "@/shared/lib/utils";
import { formatMsg, msg } from "@/shared/lib/messages";
import { DATASET_UPLOAD_ACCEPT } from "@/shared/lib/parse-dataset";

import type { BlackboxWizardContext } from "../../hooks/use-blackbox-wizard";
import { StepCard, cnGrid } from "./shared";

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
    clearCases,
  } = w;
  // Cases are opt-in: the switch opens the section, and it stays on while
  // there are cases in it (a clone, an upload, or the agent staging rows).
  const [requested, setRequested] = useState(false);
  const open = requested || Boolean(parsedCases);

  return (
    <StepCard
      title={msg("submit.blackbox.cases.title")}
      tip={msg("submit.blackbox.cases.none_hint")}
      description={msg("submit.blackbox.cases.desc")}
      trailing={
        <div className="flex items-center gap-2">
          <Label htmlFor="bb-cases-toggle" className="cursor-pointer">
            {msg("submit.blackbox.cases.add")}
          </Label>
          <Switch
            id="bb-cases-toggle"
            checked={open}
            aria-controls="bb-cases-body"
            onCheckedChange={(checked) => {
              // Turning cases off means the run has none, so drop any loaded.
              if (!checked) clearCases();
              setRequested(checked);
            }}
          />
        </div>
      }
    >
      <div id="bb-cases-body" className={cnGrid(open)} inert={open ? undefined : true}>
        <div className="min-h-0 space-y-5 overflow-hidden">
          <p className="text-sm text-muted-foreground">{msg("submit.blackbox.cases.how")}</p>
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
                <Badge variant="secondary" size="sm" className="mt-2">
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
                accept={DATASET_UPLOAD_ACCEPT}
                className="sr-only"
                onChange={handleFileUpload}
              />
            </label>

            <div className="flex items-center gap-3">
              <Separator className="flex-1" />
              <span className="text-xs text-muted-foreground">
                {msg("submit.dataset.library_or")}
              </span>
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
            <ImportFromMenu
              onImported={handlePickFromLibrary}
              className="min-h-[44px] w-full justify-center gap-2 lg:min-h-0"
            />
          </DatasetPreviewLayout>
        </div>
      </div>
      <DatasetPickerDialog
        open={libraryOpen}
        onOpenChange={setLibraryOpen}
        onPick={handlePickFromLibrary}
      />
    </StepCard>
  );
}
