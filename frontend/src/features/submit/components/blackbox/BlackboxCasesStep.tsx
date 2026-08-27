"use client";

import { Books, UploadSimple, X } from "@/shared/ui/icons";
import { Badge } from "@/shared/ui/primitives/badge";
import { Button } from "@/shared/ui/primitives/button";
import { Label } from "@/shared/ui/primitives/label";
import { Separator } from "@/shared/ui/primitives/separator";
import { Switch } from "@/shared/ui/primitives/switch";
import { NumberInput } from "@/shared/ui/number-input";
import { DatasetPickerDialog } from "@/features/datasets";
import { cn } from "@/shared/lib/utils";
import { formatMsg, msg } from "@/shared/lib/messages";

import type { BlackboxWizardContext } from "../../hooks/use-blackbox-wizard";
import { MOBILE_NUMBER_INPUT_CLASS, StepCard } from "./shared";

export function BlackboxCasesStep({ w }: { w: BlackboxWizardContext }) {
  const {
    parsedCases,
    casesName,
    handleFileUpload,
    handlePickFromLibrary,
    clearCases,
    libraryOpen,
    setLibraryOpen,
    split,
    setSplit,
    shuffle,
    setShuffle,
    targetKind,
  } = w;

  return (
    <StepCard
      title={msg("submit.blackbox.cases.title")}
      description={msg(
        targetKind === "agent" ? "submit.blackbox.cases.desc_agent" : "submit.blackbox.cases.desc",
      )}
    >
      <label
        className={cn(
          "group block cursor-pointer rounded-xl border-2 border-dashed p-6 text-center transition-all duration-300 sm:p-10",
          parsedCases
            ? "border-primary/40 bg-primary/5"
            : "hover:border-primary/50 hover:bg-muted/30",
        )}
      >
        <UploadSimple className="mx-auto mb-3 h-10 w-10 text-muted-foreground transition-colors duration-300 group-hover:text-primary/70" />
        <p className="max-w-full truncate px-4 text-sm font-medium" title={casesName || undefined}>
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
        <input
          type="file"
          accept=".csv,.json,.xlsx,.xls"
          className="hidden"
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
      <DatasetPickerDialog
        open={libraryOpen}
        onOpenChange={setLibraryOpen}
        onPick={handlePickFromLibrary}
      />

      {parsedCases ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {parsedCases.columns.map((c) => (
              <Badge key={c} variant="outline" className="font-mono">
                {c}
              </Badge>
            ))}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={clearCases}
              className="ms-auto min-h-[44px] gap-1 text-muted-foreground lg:min-h-0"
            >
              <X className="size-3.5" />
              {msg("submit.blackbox.cases.clear")}
            </Button>
          </div>
          <div className="space-y-2">
            <Label>{msg("submit.blackbox.cases.split_label")}</Label>
            <div className="grid grid-cols-3 gap-3">
              {(
                [
                  ["train", msg("submit.split.label_train")],
                  ["val", msg("submit.split.label_val")],
                  ["test", msg("submit.split.label_test")],
                ] as const
              ).map(([key, label]) => (
                <div key={key} className="space-y-1">
                  <Label htmlFor={`bb-split-${key}`} className="text-xs">
                    {label}
                  </Label>
                  <NumberInput
                    id={`bb-split-${key}`}
                    step={0.05}
                    min={0}
                    max={1}
                    value={split[key]}
                    onChange={(v) => setSplit({ ...split, [key]: v })}
                    className={MOBILE_NUMBER_INPUT_CLASS}
                  />
                </div>
              ))}
            </div>
          </div>
          <div className="flex min-h-[44px] items-center justify-between lg:min-h-0">
            <Label htmlFor="bb-shuffle">{msg("submit.blackbox.cases.shuffle")}</Label>
            <Switch id="bb-shuffle" checked={shuffle} onCheckedChange={setShuffle} />
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{msg("submit.blackbox.cases.none_hint")}</p>
      )}
    </StepCard>
  );
}
