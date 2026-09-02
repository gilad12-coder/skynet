"use client";

import { useState } from "react";
import { CaretDown, Warning } from "@/shared/ui/icons";
import { Badge } from "@/shared/ui/primitives/badge";
import { Input } from "@/shared/ui/primitives/input";
import { Label } from "@/shared/ui/primitives/label";
import { Separator } from "@/shared/ui/primitives/separator";
import { NumberInput } from "@/shared/ui/number-input";
import { HelpTip } from "@/shared/ui/help-tip";
import { ModelChip } from "@/shared/ui/model-chip";
import { cn } from "@/shared/lib/utils";
import { tip } from "@/shared/lib/tooltips";
import { formatMsg, msg } from "@/shared/lib/messages";

import type { BlackboxWizardContext } from "../../hooks/use-blackbox-wizard";
import { emptyModelConfig } from "../../constants";
import { OPTIMIZATION_MODEL_DESCRIPTION } from "../../lib/model-roles";
import { TotalBudgetCard } from "../TotalBudgetCard";
import { ModelRoleRow } from "./ModelRoleRow";
import {
  Field,
  MOBILE_INPUT_CLASS,
  MOBILE_NUMBER_INPUT_CLASS,
  Segmented,
  StepCard,
  cnGrid,
} from "./shared";

const MOBILE_MODEL_CHIP_CLASS =
  "min-h-[44px] max-lg:[&_button]:min-h-[44px] max-lg:[&_button]:min-w-[44px] max-lg:[&_button]:opacity-100";

export function BlackboxOptimizerStep({ w }: { w: BlackboxWizardContext }) {
  const {
    strategyMode,
    setStrategyMode,
    engine,
    setEngine,
    patience,
    setPatience,
    engineCatalog,
    autoEngineLabels,
    seedMode,
    targetKind,
    maxScorerRuns,
    setMaxScorerRuns,
    maxIterations,
    setMaxIterations,
    stopAtScore,
    setStopAtScore,
    reflectionModel,
    setReflectionModel,
    optimizationFamily,
    scorerUsesModel,
    scorerModelMode,
    setEditingModel,
    catalog,
    tokenSource,
  } = w;

  const engines = engineCatalog?.engines ?? [];
  const single = strategyMode === "single";
  // Opens by itself when a limit is already set (a clone, a returning draft)
  // so nothing that shapes the run hides behind a closed panel.
  const [advancedOpen, setAdvancedOpen] = useState(
    () => maxIterations !== "" || stopAtScore.trim() !== "",
  );
  const optimizationLabel = msg("submit.blackbox.roles.optimization.label");

  return (
    <StepCard
      title={msg("submit.blackbox.optimizer.title")}
      description={msg("submit.blackbox.optimizer.desc")}
    >
      <Segmented<"auto" | "single" | "plateau">
        value={strategyMode}
        onChange={setStrategyMode}
        options={[
          {
            value: "auto",
            label: msg("submit.blackbox.strategy.auto"),
            desc: msg("submit.blackbox.strategy.auto_desc"),
          },
          {
            value: "plateau",
            label: msg("submit.blackbox.strategy.plateau"),
            desc: msg("submit.blackbox.strategy.plateau_desc"),
          },
          {
            value: "single",
            label: msg("submit.blackbox.strategy.single"),
            desc: msg("submit.blackbox.strategy.single_desc"),
          },
        ]}
      />

      {!single && engineCatalog && (
        <p
          className={cn(
            "text-xs leading-relaxed",
            autoEngineLabels.length > 0 ? "text-muted-foreground" : "text-amber-700",
          )}
        >
          {autoEngineLabels.length > 0
            ? formatMsg("submit.blackbox.engines.auto_can_run", {
                engines: autoEngineLabels.join(" · "),
              })
            : msg("submit.blackbox.engines.auto_none")}
        </p>
      )}

      {strategyMode === "plateau" && (
        <Field
          label={msg("submit.blackbox.strategy.patience_label")}
          tip="submit.blackbox.patience"
          htmlFor="bb-patience"
          hint={msg("submit.blackbox.strategy.patience_hint")}
        >
          <NumberInput
            id="bb-patience"
            value={patience}
            onChange={setPatience}
            min={5}
            max={10000}
            step={5}
            className={MOBILE_NUMBER_INPUT_CLASS}
          />
        </Field>
      )}

      {targetKind === "agent" && engineCatalog && !engineCatalog.sandbox_available && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-[0.75rem] text-amber-700">
          <Warning className="mt-0.5 size-4 shrink-0" />
          <span>
            {formatMsg("submit.blackbox.engines.sandbox_missing", {
              reason: engineCatalog.sandbox_reason ?? "",
            })}
          </span>
        </div>
      )}

      {single && (
        <div id="bb-engines" tabIndex={-1} className="space-y-2 outline-none">
          <Label>
            <HelpTip text={tip("submit.blackbox.engines")}>
              {msg("submit.blackbox.engines.label")}
            </HelpTip>
          </Label>
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup">
            {engines.map((e) => {
              // Only a seed shape the engine cannot take blocks the choice.
              // An engine that cannot run yet stays selectable and
              // configurable; Run is what waits for it.
              const partsBlocked = seedMode === "parts" && !e.supports_parts;
              const selected = engine === e.id;
              return (
                <button
                  key={e.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={partsBlocked}
                  onClick={() => setEngine(e.id)}
                  className={cn(
                    "flex min-h-[44px] flex-col items-start gap-1 rounded-lg border p-3 text-start transition-colors",
                    selected ? "border-primary bg-primary/5" : "border-border/50 bg-background/60",
                    !partsBlocked && !selected && "cursor-pointer hover:border-primary/50",
                    partsBlocked && "opacity-60",
                  )}
                >
                  <span className="flex w-full items-center gap-2">
                    <span className="text-sm font-medium">{e.label}</span>
                    <span className="ms-auto flex gap-1">
                      {e.supports_parts && (
                        <Badge variant="outline" size="sm">
                          {msg("submit.blackbox.engines.parts")}
                        </Badge>
                      )}
                      {!e.available && (
                        <Badge variant="secondary" size="sm">
                          {msg("submit.blackbox.engines.not_runnable")}
                        </Badge>
                      )}
                    </span>
                  </span>
                  <span className="text-[0.6875rem] leading-relaxed text-muted-foreground">
                    {e.description}
                  </span>
                  {!e.available && e.unavailable_reason && (
                    <span className="text-[0.6875rem] leading-relaxed text-amber-700" dir="auto">
                      {e.unavailable_reason}
                    </span>
                  )}
                </button>
              );
            })}
            {engineCatalog && engines.length === 0 && (
              <p className="text-xs text-muted-foreground">{msg("submit.blackbox.engines.none")}</p>
            )}
          </div>
        </div>
      )}

      <Separator />

      <ModelRoleRow
        id="bb-optimization-model"
        role={optimizationLabel}
        modelName={reflectionModel.name.trim() || null}
        description={
          <>
            {msg(OPTIMIZATION_MODEL_DESCRIPTION[optimizationFamily])}
            {scorerUsesModel && scorerModelMode === "inherit" && (
              <> {msg("submit.blackbox.roles.optimization.also_scoring")}</>
            )}
          </>
        }
        tip={tip("blackbox.config.reflection_model")}
      >
        <ModelChip
          config={reflectionModel}
          className={MOBILE_MODEL_CHIP_CLASS}
          roleLabel={optimizationLabel}
          tooltip={msg("model.reflection.explainer")}
          required
          catalogModels={catalog?.models}
          onClick={() =>
            setEditingModel({
              config: reflectionModel,
              onSave: setReflectionModel,
              label: optimizationLabel,
            })
          }
          onRemove={reflectionModel.name ? () => setReflectionModel(emptyModelConfig()) : undefined}
        />
      </ModelRoleRow>

      <Separator />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label={msg("submit.blackbox.budget.max_runs")}
          htmlFor="bb-max-runs"
          tip="blackbox.config.budget_runs"
        >
          <NumberInput
            id="bb-max-runs"
            value={maxScorerRuns}
            onChange={setMaxScorerRuns}
            min={1}
            max={100000}
            step={10}
            className={MOBILE_NUMBER_INPUT_CLASS}
          />
        </Field>
      </div>

      <div className="space-y-2">
        <button
          type="button"
          onClick={() => setAdvancedOpen((open) => !open)}
          aria-expanded={advancedOpen}
          aria-controls="bb-advanced"
          className="flex min-h-[44px] w-full items-center gap-2 text-start text-sm font-medium lg:min-h-0"
        >
          <CaretDown
            className={cn("size-4 transition-transform", advancedOpen && "rotate-180")}
            aria-hidden="true"
          />
          <span>{msg("submit.blackbox.optimizer.advanced")}</span>
          <span className="text-xs font-normal text-muted-foreground">
            {msg("submit.blackbox.optimizer.advanced_hint")}
          </span>
        </button>
        <div id="bb-advanced" className={cnGrid(advancedOpen)}>
          <div className="overflow-hidden">
            <div className="grid gap-4 pt-1 sm:grid-cols-2">
              <Field
                label={msg("submit.blackbox.budget.max_iterations")}
                htmlFor="bb-max-iterations"
                tip="blackbox.config.budget_iterations"
              >
                <NumberInput
                  id="bb-max-iterations"
                  value={maxIterations}
                  onChange={setMaxIterations}
                  min={1}
                  max={1000}
                  className={MOBILE_NUMBER_INPUT_CLASS}
                  disabled={!advancedOpen}
                />
              </Field>
              <Field
                label={msg("submit.blackbox.budget.stop_at")}
                htmlFor="bb-stop-at"
                tip="blackbox.config.budget_stop"
              >
                <Input
                  id="bb-stop-at"
                  inputMode="decimal"
                  value={stopAtScore}
                  onChange={(e) => setStopAtScore(e.target.value)}
                  dir="ltr"
                  className={MOBILE_INPUT_CLASS}
                  disabled={!advancedOpen}
                />
              </Field>
            </div>
          </div>
        </div>
      </div>

      <TotalBudgetCard w={w} mode={tokenSource} />
    </StepCard>
  );
}
