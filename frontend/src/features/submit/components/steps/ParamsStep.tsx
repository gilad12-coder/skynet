"use client";

import { CaretDown } from "@/shared/ui/icons";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/shared/ui/primitives/card";
import { Label } from "@/shared/ui/primitives/label";
import { Switch } from "@/shared/ui/primitives/switch";
import { Separator } from "@/shared/ui/primitives/separator";
import { NumberInput } from "@/shared/ui/number-input";
import { HelpTip } from "@/shared/ui/help-tip";
import { cn } from "@/shared/lib/utils";
import { tip } from "@/shared/lib/tooltips";
import { TERMS } from "@/shared/lib/terms";
import { formatMsg, msg } from "@/shared/lib/messages";

import type { SubmitWizardContext } from "../../hooks/use-submit-wizard";
import { AUTO_METRIC_CALLS } from "../../lib/cost-bracket";

const MOBILE_NUMBER_INPUT_CLASS =
  "h-[44px] [&_button]:size-[44px] [&_input]:text-base lg:h-9 lg:[&_button]:size-9 lg:[&_input]:text-sm";

// The empty level is the escape hatch: no preset, the user sets the budget.
const DEPTH_LEVELS = ["light", "medium", "heavy", ""] as const;
const DEPTH_HINT_KEY = {
  light: "submit.depth.hint.light",
  medium: "submit.depth.hint.medium",
  heavy: "submit.depth.hint.heavy",
} as const;
type DepthLevel = (typeof DEPTH_LEVELS)[number];

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: ReadonlyArray<readonly [T, string]>;
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  const count = options.length;
  const idx = Math.max(
    0,
    options.findIndex(([v]) => v === value),
  );
  // p-1 (4px) around and gap-1 (4px) between segments: the sliding pill has
  // to subtract both or it drifts off-centre past the second segment.
  const segmentWidth = `((100% - ${8 + 4 * (count - 1)}px) / ${count})`;
  return (
    <div className={cn("relative inline-flex w-full rounded-lg bg-muted p-1 gap-1", className)}>
      <div
        className="pointer-events-none absolute top-1 bottom-1 rounded-md bg-background shadow-sm transition-[inset-inline-start] duration-150 ease-out"
        style={{
          width: `calc(${segmentWidth})`,
          insetInlineStart: `calc(4px + ${idx} * (${segmentWidth} + 4px))`,
        }}
      />
      {options.map(([val, label]) => (
        <button
          key={val}
          type="button"
          onClick={() => onChange(val)}
          aria-pressed={value === val}
          className={cn(
            "relative z-[1] min-h-[44px] min-w-0 flex-1 cursor-pointer truncate rounded-md px-2 py-1.5 text-center text-xs font-medium transition-colors lg:min-h-0",
            value === val ? "text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function ParamsStep({ w }: { w: SubmitWizardContext }) {
  const {
    autoLevel,
    setAutoLevel,
    reflectionMinibatchSize,
    setReflectionMinibatchSize,
    maxFullEvals,
    setMaxFullEvals,
    maxMetricCalls,
    setMaxMetricCalls,
    useMerge,
    setUseMerge,
    optimizerName,
    targetScore,
    setTargetScore,
    pxnParents,
    setPxnParents,
    pxnProposals,
    setPxnProposals,
    optimizerSettingsOpen,
    setOptimizerSettingsOpen,
    optimizerSettingsCustomized,
  } = w;
  const isGepa = optimizerName.toLowerCase() === "gepa";
  const depth: DepthLevel = (DEPTH_LEVELS as readonly string[]).includes(autoLevel)
    ? (autoLevel as DepthLevel)
    : "";
  const budgetUnit: "rounds" | "calls" = maxMetricCalls ? "calls" : "rounds";
  const targetScoreValue = Number.parseFloat(targetScore);
  // p*n candidates per reflective round; only worth spelling out once batching
  // is actually on (1x1 is GEPA's classic one-candidate default).
  const pxnBatch = (parseInt(pxnParents, 10) || 1) * (parseInt(pxnProposals, 10) || 1);

  const depthHint = depth
    ? formatMsg(DEPTH_HINT_KEY[depth], { calls: AUTO_METRIC_CALLS[depth] ?? 0 })
    : msg("submit.depth.hint.custom");

  return (
    <Card
      className=" border-border/50 bg-card/80 backdrop-blur-xl shadow-lg"
      data-tutorial="wizard-step-5"
    >
      <CardHeader className="px-4 sm:px-6">
        <CardTitle className="text-lg">
          {msg("auto.features.submit.components.steps.paramsstep.1")}
        </CardTitle>
        <CardDescription>{msg("submit.params.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6 px-4 sm:px-6">
        <div className="space-y-3" data-tutorial="auto-level">
          <Label className="text-sm font-semibold">
            <HelpTip text={tip("submit.depth")}>
              {msg("auto.features.submit.components.steps.paramsstep.12")}
            </HelpTip>
          </Label>
          <SegmentedControl
            options={[
              ["light", msg("auto.features.submit.components.steps.paramsstep.literal.1")],
              ["medium", msg("auto.features.submit.components.steps.paramsstep.literal.2")],
              ["heavy", msg("auto.features.submit.components.steps.paramsstep.literal.3")],
              ["", msg("submit.depth.custom")],
            ]}
            value={depth}
            onChange={setAutoLevel}
          />
          <p className="text-xs text-muted-foreground">{depthHint}</p>
          {!depth && (
            <div className="space-y-3 rounded-lg border border-border/50 bg-muted/30 p-3 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-1 motion-safe:duration-200">
              <SegmentedControl
                options={[
                  ["rounds", msg("auto.features.submit.components.steps.paramsstep.14")],
                  ["calls", msg("submit.metric_calls")],
                ]}
                value={budgetUnit}
                onChange={(unit) =>
                  setMaxMetricCalls(
                    unit === "calls" ? maxMetricCalls || String(AUTO_METRIC_CALLS.light) : "",
                  )
                }
              />
              {budgetUnit === "calls" ? (
                <div className="space-y-1.5">
                  <Label htmlFor="max-metric-calls" className="text-xs">
                    <HelpTip text={tip("submit.metric_calls")}>
                      {msg("submit.metric_calls")}
                    </HelpTip>
                  </Label>
                  <NumberInput
                    id="max-metric-calls"
                    min={1}
                    max={100000}
                    step={1}
                    value={parseInt(maxMetricCalls, 10)}
                    onChange={(v) => setMaxMetricCalls(String(v))}
                    className={cn(MOBILE_NUMBER_INPUT_CLASS, "max-w-48")}
                  />
                </div>
              ) : (
                <div className="space-y-1.5">
                  <Label htmlFor="max-full-evals" className="text-xs">
                    <HelpTip text={tip("submit.eval_rounds")}>
                      {msg("auto.features.submit.components.steps.paramsstep.14")}
                    </HelpTip>
                  </Label>
                  <NumberInput
                    id="max-full-evals"
                    min={1}
                    max={50}
                    step={1}
                    value={maxFullEvals ? parseInt(maxFullEvals, 10) : ""}
                    onChange={(v) => setMaxFullEvals(String(v))}
                    className={cn(MOBILE_NUMBER_INPUT_CLASS, "max-w-48")}
                  />
                </div>
              )}
            </div>
          )}
        </div>

        <Separator />

        <div className="space-y-3">
          <button
            type="button"
            onClick={() => setOptimizerSettingsOpen(!optimizerSettingsOpen)}
            aria-expanded={optimizerSettingsOpen}
            className="flex min-h-[44px] w-full cursor-pointer items-center justify-between gap-2 lg:min-h-0"
          >
            <span className="flex items-baseline gap-2">
              <HelpTip text={tip("submit.optimizer_params")}>
                <span className="text-sm leading-none font-semibold">
                  {msg("auto.features.submit.components.steps.paramsstep.11")}
                  {TERMS.optimizer}
                </span>
              </HelpTip>
              {!optimizerSettingsOpen && (
                <span className="text-xs text-muted-foreground">
                  {optimizerSettingsCustomized
                    ? msg("submit.optimizer_settings.customized")
                    : msg("submit.optimizer_settings.defaults")}
                </span>
              )}
            </span>
            <CaretDown
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform duration-150",
                optimizerSettingsOpen && "rotate-180",
              )}
            />
          </button>
          {optimizerSettingsOpen && (
            <div
              className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-1 motion-safe:duration-200"
              data-tutorial="gepa-params"
            >
              <div className="space-y-1.5">
                <Label htmlFor="reflection-minibatch" className="text-xs">
                  <HelpTip text={tip("submit.reflection_minibatch")}>
                    {msg("auto.features.submit.components.steps.paramsstep.13")}
                  </HelpTip>
                </Label>
                <NumberInput
                  id="reflection-minibatch"
                  min={1}
                  max={20}
                  step={1}
                  value={reflectionMinibatchSize ? parseInt(reflectionMinibatchSize, 10) : ""}
                  onChange={(v) => setReflectionMinibatchSize(String(v))}
                  className={MOBILE_NUMBER_INPUT_CLASS}
                />
              </div>
              <div className="flex items-center justify-between gap-3 sm:self-end sm:h-9 sm:mb-0">
                <Label htmlFor="use-merge" className="cursor-pointer text-xs">
                  <HelpTip text={tip("submit.merge")}>
                    {msg("auto.features.submit.components.steps.paramsstep.15")}
                  </HelpTip>
                </Label>
                <Switch
                  id="use-merge"
                  checked={useMerge}
                  onCheckedChange={setUseMerge}
                  className="relative before:absolute before:-inset-3 before:content-[''] lg:before:hidden"
                />
              </div>
              {isGepa && (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor="pxn-parents" className="text-xs">
                      <HelpTip text={tip("submit.pxn_parents")}>
                        {msg("submit.pxn.parents")}
                      </HelpTip>
                    </Label>
                    <NumberInput
                      id="pxn-parents"
                      min={1}
                      max={16}
                      step={1}
                      value={pxnParents ? parseInt(pxnParents, 10) : ""}
                      onChange={(v) => setPxnParents(String(v))}
                      className={MOBILE_NUMBER_INPUT_CLASS}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="pxn-proposals" className="text-xs">
                      <HelpTip text={tip("submit.pxn_proposals")}>
                        {msg("submit.pxn.proposals")}
                      </HelpTip>
                    </Label>
                    <NumberInput
                      id="pxn-proposals"
                      min={1}
                      max={16}
                      step={1}
                      value={pxnProposals ? parseInt(pxnProposals, 10) : ""}
                      onChange={(v) => setPxnProposals(String(v))}
                      className={MOBILE_NUMBER_INPUT_CLASS}
                    />
                  </div>
                  {pxnBatch > 1 && (
                    <p className="col-span-1 -mt-2 text-xs text-muted-foreground sm:col-span-2">
                      {formatMsg("submit.pxn.batch_hint", { total: pxnBatch })}
                    </p>
                  )}
                  <div className="col-span-1 space-y-1.5 sm:col-span-2">
                    <Label htmlFor="target-score" className="text-xs">
                      <HelpTip text={tip("submit.target_score")}>
                        {msg("auto.features.submit.components.steps.paramsstep.16")}
                      </HelpTip>
                    </Label>
                    <div className="relative w-full max-w-48">
                      <NumberInput
                        id="target-score"
                        min={1}
                        max={100}
                        step={0.1}
                        value={Number.isFinite(targetScoreValue) ? targetScoreValue : ""}
                        onChange={(value) => setTargetScore(String(value))}
                        className={cn(MOBILE_NUMBER_INPUT_CLASS, "pe-8")}
                      />
                      <span className="pointer-events-none absolute inset-y-0 end-3 flex items-center text-xs text-muted-foreground">
                        %
                      </span>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
