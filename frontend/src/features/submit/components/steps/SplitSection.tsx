"use client";

import { useState } from "react";
import { Button } from "@/shared/ui/primitives/button";
import { getActiveIntlLocale } from "@/shared/lib/runtime-locale";
import { splitExampleCounts } from "../../lib/split-example-counts";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/shared/ui/primitives/card";
import { Label } from "@/shared/ui/primitives/label";
import { Badge } from "@/shared/ui/primitives/badge";
import { NumberInput } from "@/shared/ui/number-input";
import { HelpTip } from "@/shared/ui/help-tip";
import { tip } from "@/shared/lib/tooltips";
import { TERMS } from "@/shared/lib/terms";
import { msg } from "@/shared/lib/messages";

import type { SubmitWizardContext } from "../../hooks/use-submit-wizard";
import { SplitRecommendationHelp, type SplitPlanControls } from "../SplitRecommendationHelp";

export type SplitControls = SplitPlanControls &
  Pick<SubmitWizardContext, "split" | "updateSplit" | "splitSum">;

const MOBILE_NUMBER_INPUT_CLASS =
  "h-[44px] [&_button]:size-[44px] [&_input]:text-base lg:h-9 lg:[&_button]:size-9 lg:[&_input]:text-sm";

export function SplitSection({ w, totalRows }: { w: SplitControls; totalRows: number }) {
  const { split, updateSplit, splitSum, splitMode, setSplitMode, splitPlan, profileLoading } = w;
  const [editing, setEditingState] = useState(false);
  const setEditing = (open: boolean) => {
    if (open) setSplitMode("manual");
    setEditingState(open);
  };
  const locale = getActiveIntlLocale();
  const counts = splitExampleCounts(totalRows, split);
  const percent = (value: number) =>
    new Intl.NumberFormat(locale, {
      style: "percent",
      maximumFractionDigits: 2,
    }).format(value);
  const examples = (count: number) =>
    msg("submit.split.example_count", {
      count: new Intl.NumberFormat(locale).format(count),
    });
  return (
    <Card
      className="border-border/50 bg-card/80 backdrop-blur-xl shadow-lg"
      data-tutorial="wizard-step-6"
    >
      <CardHeader className="px-4 sm:px-6">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">
            <HelpTip text={tip("data.split_explanation")}>
              {msg("auto.features.submit.components.steps.paramsstep.4")}
              {TERMS.dataset}
            </HelpTip>
          </CardTitle>
          {splitSum !== 1 && (
            <Badge variant="destructive" className="text-xs">
              {msg("auto.features.submit.components.steps.paramsstep.5")}
              {splitSum}
            </Badge>
          )}
        </div>
        <CardDescription>{msg("submit.split.step_desc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 px-4 sm:px-6" data-tutorial="data-splits">
        {!splitPlan && !profileLoading && (
          <p className="text-sm text-muted-foreground">{msg("submit.split.empty")}</p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <SplitRecommendationHelp w={w} />
          </div>
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-lg bg-muted p-0.5">
              <Button
                type="button"
                variant={splitMode === "auto" ? "secondary" : "ghost"}
                size="sm"
                className="min-h-[44px]"
                aria-pressed={splitMode === "auto"}
                onClick={() => {
                  setSplitMode("auto");
                  setEditingState(false);
                }}
              >
                {msg("submit.split.mode_auto")}
              </Button>
              <Button
                type="button"
                variant={splitMode === "manual" ? "secondary" : "ghost"}
                size="sm"
                className="min-h-[44px]"
                aria-pressed={splitMode === "manual"}
                onClick={() => setEditing(true)}
              >
                {msg("submit.split.mode_manual")}
              </Button>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-[44px]"
              aria-expanded={editing}
              aria-controls="split-adjust"
              disabled={editing && splitSum !== 1}
              onClick={() => setEditing(!editing)}
            >
              {msg(editing ? "tagger.results.edit_done" : "submit.blackbox.review.edit")}
            </Button>
          </div>
        </div>
        <div id="split-adjust" className="space-y-3 pt-1">
          <div className="flex h-3 rounded-full overflow-hidden">
            <div
              className="bg-[#3D2E22] transition-all"
              style={{ width: `${split.train * 100}%` }}
            />
            <div className="bg-[#C8A882] transition-all" style={{ width: `${split.val * 100}%` }} />
            <div
              className="bg-[#8C7A6B] transition-all"
              style={{ width: `${split.test * 100}%` }}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-1">
              <Label
                htmlFor={editing ? "split-train" : undefined}
                className="flex items-center gap-1.5 text-xs"
              >
                <span className="inline-block w-2 h-2 rounded-full bg-[#3D2E22]" />
                <HelpTip text={tip("data.split.train")}>{msg("submit.split.label_train")}</HelpTip>
              </Label>
              {editing ? (
                <NumberInput
                  id="split-train"
                  step={0.05}
                  min={0}
                  max={1}
                  value={split.train}
                  onChange={(v) => {
                    setSplitMode("manual");
                    updateSplit("train", String(v));
                  }}
                  className={MOBILE_NUMBER_INPUT_CLASS}
                />
              ) : (
                <p className="py-2 text-lg font-semibold tabular-nums" dir="auto">
                  {percent(split.train)}
                </p>
              )}
              <p
                className="text-sm text-muted-foreground tabular-nums"
                aria-live="polite"
                dir="auto"
              >
                {examples(counts.train)}
              </p>
            </div>
            <div className="space-y-1">
              <Label
                htmlFor={editing ? "split-val" : undefined}
                className="flex items-center gap-1.5 text-xs"
              >
                <span className="inline-block w-2 h-2 rounded-full bg-[#C8A882]" />
                <HelpTip text={tip("data.split.val")}>{msg("submit.split.label_val")}</HelpTip>
              </Label>
              {editing ? (
                <NumberInput
                  id="split-val"
                  step={0.05}
                  min={0}
                  max={1}
                  value={split.val}
                  onChange={(v) => {
                    setSplitMode("manual");
                    updateSplit("val", String(v));
                  }}
                  className={MOBILE_NUMBER_INPUT_CLASS}
                />
              ) : (
                <p className="py-2 text-lg font-semibold tabular-nums" dir="auto">
                  {percent(split.val)}
                </p>
              )}
              <p
                className="text-sm text-muted-foreground tabular-nums"
                aria-live="polite"
                dir="auto"
              >
                {examples(counts.val)}
              </p>
            </div>
            <div className="space-y-1">
              <Label
                htmlFor={editing ? "split-test" : undefined}
                className="flex items-center gap-1.5 text-xs"
              >
                <span className="inline-block w-2 h-2 rounded-full bg-[#8C7A6B]" />
                <HelpTip text={tip("data.split.test")}>{msg("submit.split.label_test")}</HelpTip>
              </Label>
              {editing ? (
                <NumberInput
                  id="split-test"
                  step={0.05}
                  min={0}
                  max={1}
                  value={split.test}
                  onChange={(v) => {
                    setSplitMode("manual");
                    updateSplit("test", String(v));
                  }}
                  className={MOBILE_NUMBER_INPUT_CLASS}
                />
              ) : (
                <p className="py-2 text-lg font-semibold tabular-nums" dir="auto">
                  {percent(split.test)}
                </p>
              )}
              <p
                className="text-sm text-muted-foreground tabular-nums"
                aria-live="polite"
                dir="auto"
              >
                {examples(counts.test)}
              </p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
