"use client";

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
import { useUserPrefs } from "@/features/settings";

import type { SubmitWizardContext } from "../../hooks/use-submit-wizard";
import { SplitRecommendationCard, type SplitPlanControls } from "../SplitRecommendationCard";

export type SplitControls = SplitPlanControls &
  Pick<SubmitWizardContext, "split" | "updateSplit" | "splitSum">;

const MOBILE_NUMBER_INPUT_CLASS =
  "h-[44px] [&_button]:size-[44px] [&_input]:text-base lg:h-9 lg:[&_button]:size-9 lg:[&_input]:text-sm";

// Simple mode shows the recommendation read-only; advanced mode adds the
// manual toggle and inputs.
export function SplitSection({ w }: { w: SplitControls }) {
  const { prefs } = useUserPrefs();
  const { split, updateSplit, splitSum, splitMode, splitPlan, profileLoading } = w;
  const advanced = prefs.advancedMode;

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
        <SplitRecommendationCard w={w} readOnly={!advanced} />
        {advanced && splitMode === "manual" && (
          <div className="space-y-3">
            <div className="flex h-3 rounded-full overflow-hidden">
              <div
                className="bg-[#3D2E22] transition-all"
                style={{ width: `${split.train * 100}%` }}
              />
              <div
                className="bg-[#C8A882] transition-all"
                style={{ width: `${split.val * 100}%` }}
              />
              <div
                className="bg-[#8C7A6B] transition-all"
                style={{ width: `${split.test * 100}%` }}
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="space-y-1">
                <Label htmlFor="split-train" className="flex items-center gap-1.5 text-xs">
                  <span className="inline-block w-2 h-2 rounded-full bg-[#3D2E22]" />
                  <HelpTip text={tip("data.split.train")}>
                    {msg("auto.features.submit.components.steps.paramsstep.6")}
                  </HelpTip>
                </Label>
                <NumberInput
                  id="split-train"
                  step={0.05}
                  min={0}
                  max={1}
                  value={split.train}
                  onChange={(v) => updateSplit("train", String(v))}
                  className={MOBILE_NUMBER_INPUT_CLASS}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="split-val" className="flex items-center gap-1.5 text-xs">
                  <span className="inline-block w-2 h-2 rounded-full bg-[#C8A882]" />
                  <HelpTip text={tip("data.split.val")}>
                    {msg("auto.features.submit.components.steps.paramsstep.7")}
                  </HelpTip>
                </Label>
                <NumberInput
                  id="split-val"
                  step={0.05}
                  min={0}
                  max={1}
                  value={split.val}
                  onChange={(v) => updateSplit("val", String(v))}
                  className={MOBILE_NUMBER_INPUT_CLASS}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="split-test" className="flex items-center gap-1.5 text-xs">
                  <span className="inline-block w-2 h-2 rounded-full bg-[#8C7A6B]" />
                  <HelpTip text={tip("data.split.test")}>
                    {msg("auto.features.submit.components.steps.paramsstep.8")}
                  </HelpTip>
                </Label>
                <NumberInput
                  id="split-test"
                  step={0.05}
                  min={0}
                  max={1}
                  value={split.test}
                  onChange={(v) => updateSplit("test", String(v))}
                  className={MOBILE_NUMBER_INPUT_CLASS}
                />
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
