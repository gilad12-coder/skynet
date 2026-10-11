"use client";

import * as React from "react";

import { DatasetPickerDialog } from "@/features/datasets";
import { ImportFromMenu } from "@/features/connectors";
import { Books, Trash, UploadSimple } from "@/shared/ui/icons";
import { Badge } from "@/shared/ui/primitives/badge";
import { Button } from "@/shared/ui/primitives/button";
import { Label } from "@/shared/ui/primitives/label";
import { Separator } from "@/shared/ui/primitives/separator";
import { Textarea } from "@/shared/ui/primitives/textarea";
import { PingDot } from "@/shared/ui/ping-dot";
import { DATASET_UPLOAD_ACCEPT } from "@/shared/lib/parse-dataset";
import { getActiveIntlLocale } from "@/shared/lib/runtime-locale";
import { cn } from "@/shared/lib/utils";

import { useInputsInference } from "../../hooks/use-inputs-inference";
import { useWizardV2 } from "../../hooks/use-unified-wizard";
import { v2Msg } from "./ArtifactConfirmCard";
import { InputsConfirmCard } from "./InputsConfirmCard";
import { WizardScreen } from "./WizardScreen";

type MessageParams = Record<string, string | number>;

/**
 * Step 2, Inputs: bring a table (upload, library or connector import) or
 * type one input; the backend infers whether it is one input or
 * input/output pairs, and the confirm card settles it with clicks. The chat
 * for this step is the app's generalist panel. Screen 0 brings the data,
 * screen 1 (once there is data) confirms how it maps.
 */
export function InputsStep({ page }: { page: number }) {
  const ctx = useWizardV2();
  const { state, patchInputs, guided } = ctx;
  const inputs = state.inputs;
  const inference = useInputsInference(ctx);
  const t = (key: string, params?: MessageParams) => v2Msg(key, guided, params);
  const fmt = (n: number) => new Intl.NumberFormat(getActiveIntlLocale()).format(n);

  const [typed, setTyped] = React.useState("");
  const hasData = inputs.cases.length > 0;
  const fromTable = inputs.datasetLabel !== null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-5 px-4 py-5 sm:px-6 sm:py-6">
      <header className="flex shrink-0 flex-col gap-1">
        <h3 className="text-base font-semibold text-foreground">{t("submit.v2.inputs.title")}</h3>
        <p className="text-sm text-muted-foreground">{t("submit.v2.inputs.desc")}</p>
      </header>

      <WizardScreen active={page === 0}>
        <section
          aria-labelledby="v2-inputs-source-title"
          className="flex flex-col gap-4 rounded-2xl border border-border/60 bg-background/70 px-4 py-4"
        >
          <div className="flex items-center justify-between gap-3">
            <h4 id="v2-inputs-source-title" className="text-sm font-semibold text-foreground">
              {t("submit.v2.inputs.source.title")}
            </h4>
            {hasData && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setTyped("");
                  inference.clear();
                }}
                className="min-h-11 gap-1.5 lg:min-h-8"
              >
                <Trash className="size-3.5" aria-hidden="true" />
                {t("submit.v2.inputs.source.clear")}
              </Button>
            )}
          </div>

          <label
            className={cn(
              "group relative block cursor-pointer rounded-xl border-2 border-dashed text-center transition-colors duration-200 focus-within:ring-2 focus-within:ring-ring",
              fromTable ? "p-4" : "p-6 hover:border-primary-fill/50 hover:bg-muted/30 sm:p-8",
            )}
          >
            {inference.loading ? (
              <PingDot size="sm" tone="agent" className="mx-auto mb-3" />
            ) : (
              <UploadSimple
                className="mx-auto mb-3 size-9 text-muted-foreground transition-colors duration-300 group-hover:text-primary/70"
                aria-hidden="true"
              />
            )}
            <p
              className="max-w-full truncate px-4 text-sm font-medium"
              title={inputs.datasetLabel ?? undefined}
            >
              {inputs.datasetLabel ?? t("submit.v2.inputs.source.upload")}
            </p>
            {fromTable && (
              <Badge variant="secondary" size="sm" className="mt-2">
                {t("submit.v2.inputs.source.loaded", {
                  rows: fmt(inputs.rowCount),
                  cols: fmt(inputs.columns.length),
                })}
              </Badge>
            )}
            <input
              type="file"
              accept={DATASET_UPLOAD_ACCEPT}
              className="sr-only"
              onChange={inference.handleFileUpload}
            />
          </label>

          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              type="button"
              variant="outline"
              onClick={() => inference.setLibraryOpen(true)}
              className="min-h-11 flex-1 justify-center gap-2 lg:min-h-9"
            >
              <Books className="size-4" aria-hidden="true" />
              {t("submit.v2.inputs.source.library")}
            </Button>
            <ImportFromMenu
              onImported={(dataset) => void inference.handlePickDataset(dataset)}
              className="min-h-11 flex-1 justify-center gap-2 lg:min-h-9"
            />
          </div>

          <div className="flex items-center gap-3">
            <Separator className="flex-1" />
            <span className="text-xs text-muted-foreground">
              {t("submit.v2.inputs.source.or_type")}
            </span>
            <Separator className="flex-1" />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="v2-typed-input">{t("submit.v2.inputs.source.typed_label")}</Label>
            <Textarea
              id="v2-typed-input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={t("submit.v2.inputs.source.typed_placeholder")}
              rows={4}
              dir="auto"
              className="min-h-24 text-sm"
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => inference.applyTypedInput(typed)}
              disabled={!typed.trim() || inference.inferring}
              className="min-h-11 self-end lg:min-h-9"
            >
              {t("submit.v2.inputs.source.typed_use")}
            </Button>
          </div>
        </section>
      </WizardScreen>

      {hasData && (
        <WizardScreen active={page === 1}>
          <InputsConfirmCard
            inputs={inputs}
            inference={inference}
            patchInputs={patchInputs}
            guided={guided}
          />
        </WizardScreen>
      )}

      <DatasetPickerDialog
        open={inference.libraryOpen}
        onOpenChange={inference.setLibraryOpen}
        onPick={(dataset) => void inference.handlePickDataset(dataset)}
      />
    </div>
  );
}
