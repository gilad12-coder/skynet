"use client";

import type { KeyboardEvent } from "react";
import { Warning } from "@/shared/ui/icons";
import { Badge } from "@/shared/ui/primitives/badge";
import { Input } from "@/shared/ui/primitives/input";
import { Label } from "@/shared/ui/primitives/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/primitives/select";
import { Switch } from "@/shared/ui/primitives/switch";
import { NumberInput } from "@/shared/ui/number-input";
import { HelpTip } from "@/shared/ui/help-tip";
import { HarnessLogo } from "@/shared/ui/harness-logo";
import { ModelChip } from "@/shared/ui/model-chip";
import { BLACKBOX_HARNESSES, harnessLabel } from "@/shared/lib/blackbox-harness";
import { cn } from "@/shared/lib/utils";
import { tip } from "@/shared/lib/tooltips";
import { formatMsg, msg } from "@/shared/lib/messages";
import { getActiveDir } from "@/shared/lib/runtime-locale";
import { radioNavigationIndex } from "../../lib/radio-navigation";
import { proposerKnobs, proposerTunesReasoning } from "../../lib/engine-contract";

import type { BlackboxProposerEffort } from "@/shared/types/api";
import type { BlackboxWizardContext } from "../../hooks/use-blackbox-wizard";
import { emptyModelConfig } from "../../constants";
import { OPTIMIZATION_MODEL_DESCRIPTION } from "../../lib/model-roles";
import { ModelRoleRow } from "./ModelRoleRow";
import {
  Field,
  MOBILE_INPUT_CLASS,
  MOBILE_NUMBER_INPUT_CLASS,
  Segmented,
  StepCard,
} from "./shared";

const PROPOSER_EFFORTS: readonly BlackboxProposerEffort[] = ["low", "medium", "high", "max"];

/** Arrow-key navigation shared by every pill radiogroup on this step. */
function moveRadioFocus(event: KeyboardEvent<HTMLButtonElement>): void {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key))
    return;
  event.preventDefault();
  const buttons = Array.from(
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [],
  );
  const index = buttons.indexOf(event.currentTarget);
  const next = radioNavigationIndex(event.key, index, buttons.length, getActiveDir() === "rtl");
  if (next === null) return;
  buttons[next]?.focus();
  buttons[next]?.click();
}

const MOBILE_MODEL_CHIP_CLASS =
  "min-h-[44px] max-lg:[&_button]:min-h-[44px] max-lg:[&_button]:min-w-[44px] max-lg:[&_button]:opacity-100";

export function BlackboxOptimizerStep({
  w,
  part,
}: {
  w: BlackboxWizardContext;
  part: "strategy" | "model";
}) {
  const {
    strategyMode,
    setStrategyMode,
    engine,
    setEngine,
    engineCatalog,
    nativeProposer,
    proposer,
    updateProposer,
    iterationLimitSupported,
    runDisabledReason,
    seedMode,
    targetKind,
    setTargetKind,
    harness,
    setHarness,
    targetModel,
    setTargetModel,
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
  } = w;

  const engines = engineCatalog?.engines ?? [];
  const single = strategyMode === "single";
  const knobs = proposerKnobs(strategyMode, engine);
  const reasoningKnobs = proposerTunesReasoning(proposer.harness);
  const optimizationLabel = msg("submit.blackbox.roles.optimization.label");
  const agentModelLabel = msg("submit.blackbox.start.agent_model_label");

  return (
    <StepCard
      title={
        part === "strategy"
          ? msg("submit.blackbox.optimizer.title")
          : msg("submit.blackbox.optimizer.model_title")
      }
      description={msg("submit.blackbox.optimizer.desc")}
    >
      {part === "strategy" && (
        <>
          <Segmented<"auto" | "single">
            label={msg("submit.blackbox.review.strategy")}
            value={strategyMode}
            onChange={setStrategyMode}
            options={[
              {
                value: "auto",
                label: msg("submit.blackbox.strategy.auto"),
                desc: msg("submit.blackbox.strategy.auto_desc"),
              },
              {
                value: "single",
                label: msg("submit.blackbox.strategy.single"),
                desc: msg("submit.blackbox.strategy.single_desc"),
              },
            ]}
          />

          {nativeProposer && (
            <Segmented<"text" | "agent">
              label={msg("submit.blackbox.start.target_label")}
              value={targetKind}
              onChange={setTargetKind}
              options={[
                {
                  value: "text",
                  label: msg("submit.blackbox.start.target.text"),
                  desc: msg("submit.blackbox.start.target.text_desc"),
                },
                {
                  value: "agent",
                  label: msg("submit.blackbox.start.target.agent"),
                  desc: msg("submit.blackbox.start.target.agent_desc"),
                },
              ]}
            />
          )}

          {nativeProposer && targetKind === "agent" && (
            <div id="bb-harness" tabIndex={-1} className="space-y-2 outline-none">
              <Label>
                <HelpTip text={tip("submit.blackbox.harness")}>
                  {msg("submit.blackbox.start.harness_label")}
                </HelpTip>
              </Label>
              <div
                className="flex flex-wrap gap-2"
                role="radiogroup"
                aria-label={msg("submit.blackbox.start.harness_label")}
              >
                {BLACKBOX_HARNESSES.map((h) => {
                  const selected = harness === h;
                  return (
                    <button
                      key={h}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      tabIndex={selected ? 0 : -1}
                      onKeyDown={moveRadioFocus}
                      onClick={() => setHarness(h)}
                      className={cn(
                        "flex min-h-[44px] items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors",
                        selected
                          ? "border-primary bg-primary/5"
                          : "border-border/50 bg-background/60 hover:border-border",
                      )}
                    >
                      <HarnessLogo harness={h} size={18} />
                      <span className="font-medium">{harnessLabel(h)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
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
              <div
                className="grid gap-2 sm:grid-cols-2"
                role="radiogroup"
                aria-label={msg("submit.blackbox.engines.label")}
              >
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
                      tabIndex={
                        selected ||
                        (!engine &&
                          engines.find((item) => seedMode !== "parts" || item.supports_parts)
                            ?.id === e.id)
                          ? 0
                          : -1
                      }
                      onKeyDown={(event) => {
                        if (
                          ![
                            "ArrowLeft",
                            "ArrowRight",
                            "ArrowUp",
                            "ArrowDown",
                            "Home",
                            "End",
                          ].includes(event.key)
                        )
                          return;
                        event.preventDefault();
                        const buttons = Array.from(
                          event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                            '[role="radio"]:not(:disabled)',
                          ) ?? [],
                        );
                        const index = buttons.indexOf(event.currentTarget);
                        const next = radioNavigationIndex(
                          event.key,
                          index,
                          buttons.length,
                          getActiveDir() === "rtl",
                        );
                        if (next === null) return;
                        buttons[next]?.focus();
                        buttons[next]?.click();
                      }}
                      disabled={partsBlocked}
                      onClick={() => setEngine(e.id)}
                      className={cn(
                        "flex min-h-[44px] flex-col items-start gap-1 rounded-lg border p-3 text-start transition-colors",
                        selected
                          ? "border-primary bg-primary/5"
                          : "border-border/50 bg-background/60",
                        !partsBlocked && !selected && "cursor-pointer hover:border-primary/50",
                        partsBlocked && "opacity-60",
                      )}
                    >
                      <span className="flex w-full items-center gap-2">
                        <span className="text-sm font-medium">{e.label}</span>
                        <span className="ms-auto flex gap-1">
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
                        <span
                          className="text-[0.6875rem] leading-relaxed text-amber-700"
                          dir="auto"
                        >
                          {e.unavailable_reason}
                        </span>
                      )}
                    </button>
                  );
                })}
                {engineCatalog && engines.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    {msg("submit.blackbox.engines.none")}
                  </p>
                )}
              </div>
            </div>
          )}

          {nativeProposer && (
            <div id="bb-proposer" tabIndex={-1} className="space-y-3 outline-none">
              <Label>
                <HelpTip text={tip("submit.blackbox.proposer")}>
                  {msg("submit.blackbox.proposer.label")}
                </HelpTip>
              </Label>
              <div
                className="flex flex-wrap gap-2"
                role="radiogroup"
                aria-label={msg("submit.blackbox.proposer.label")}
              >
                {BLACKBOX_HARNESSES.map((h) => {
                  const selected = proposer.harness === h;
                  return (
                    <button
                      key={h}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      tabIndex={selected ? 0 : -1}
                      onKeyDown={moveRadioFocus}
                      onClick={() => updateProposer({ harness: h })}
                      className={cn(
                        "flex min-h-[44px] items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors",
                        selected
                          ? "border-primary bg-primary/5"
                          : "border-border/50 bg-background/60 hover:border-border",
                      )}
                    >
                      <HarnessLogo harness={h} size={18} />
                      <span className="font-medium">{harnessLabel(h)}</span>
                    </button>
                  );
                })}
              </div>
              {(reasoningKnobs || knobs.candidates || knobs.ralph) && (
                <div className="grid gap-4 sm:grid-cols-2">
                  {reasoningKnobs && (
                    <>
                      <Field
                        label={msg("submit.blackbox.proposer.effort")}
                        htmlFor="bb-proposer-effort"
                        tip="submit.blackbox.proposer_effort"
                      >
                        <Select
                          value={proposer.effort ?? "default"}
                          onValueChange={(value) =>
                            updateProposer({
                              effort:
                                value === "default" ? null : (value as BlackboxProposerEffort),
                            })
                          }
                        >
                          <SelectTrigger id="bb-proposer-effort" className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="default">
                              {msg("submit.blackbox.proposer.effort.default")}
                            </SelectItem>
                            {PROPOSER_EFFORTS.map((effort) => (
                              <SelectItem key={effort} value={effort}>
                                {msg(`submit.blackbox.proposer.effort.${effort}`)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field
                        label={msg("submit.blackbox.proposer.max_thinking_tokens")}
                        htmlFor="bb-proposer-thinking"
                        tip="submit.blackbox.proposer_thinking"
                      >
                        <NumberInput
                          id="bb-proposer-thinking"
                          value={proposer.max_thinking_tokens ?? ""}
                          onChange={(value) => updateProposer({ max_thinking_tokens: value })}
                          onClear={() => updateProposer({ max_thinking_tokens: null })}
                          min={1024}
                          max={128000}
                          step={1024}
                          className={MOBILE_NUMBER_INPUT_CLASS}
                        />
                      </Field>
                    </>
                  )}
                  {knobs.candidates && (
                    <Field
                      label={msg("submit.blackbox.proposer.max_candidates")}
                      htmlFor="bb-proposer-candidates"
                      tip="submit.blackbox.proposer_candidates"
                    >
                      <NumberInput
                        id="bb-proposer-candidates"
                        value={proposer.max_candidates_per_iter ?? ""}
                        onChange={(value) => updateProposer({ max_candidates_per_iter: value })}
                        onClear={() => updateProposer({ max_candidates_per_iter: null })}
                        min={1}
                        max={8}
                        className={MOBILE_NUMBER_INPUT_CLASS}
                      />
                    </Field>
                  )}
                  {knobs.ralph && (
                    <>
                      <Field
                        label={msg("submit.blackbox.proposer.ralph")}
                        htmlFor="bb-proposer-ralph"
                        tip="submit.blackbox.proposer_ralph"
                      >
                        <div className="flex min-h-[44px] items-center">
                          <Switch
                            id="bb-proposer-ralph"
                            checked={proposer.ralph ?? true}
                            onCheckedChange={(checked) => updateProposer({ ralph: checked })}
                          />
                        </div>
                      </Field>
                      <Field
                        label={msg("submit.blackbox.proposer.max_no_eval")}
                        htmlFor="bb-proposer-no-eval"
                        tip="submit.blackbox.proposer_no_eval"
                      >
                        <NumberInput
                          id="bb-proposer-no-eval"
                          value={proposer.max_no_eval_seconds ?? ""}
                          onChange={(value) => updateProposer({ max_no_eval_seconds: value })}
                          onClear={() => updateProposer({ max_no_eval_seconds: null })}
                          min={1}
                          max={7200}
                          className={MOBILE_NUMBER_INPUT_CLASS}
                        />
                      </Field>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {runDisabledReason && (
            <p className="flex items-start gap-2 text-xs text-amber-700" role="status">
              <Warning className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span dir="auto">{runDisabledReason}</span>
            </p>
          )}
        </>
      )}

      {part === "model" && (
        <>
          <ModelRoleRow
            id="bb-optimization-model"
            role={optimizationLabel}
            description={[
              msg(OPTIMIZATION_MODEL_DESCRIPTION[optimizationFamily]),
              nativeProposer ? msg("submit.blackbox.roles.optimization.managed_hint") : null,
              scorerUsesModel && scorerModelMode === "inherit"
                ? msg("submit.blackbox.roles.optimization.also_scoring")
                : null,
            ]
              .filter(Boolean)
              .join(" ")}
            tip={tip("blackbox.config.reflection_model")}
          >
            <ModelChip
              config={reflectionModel}
              modelDefaultsOnly={nativeProposer}
              className={MOBILE_MODEL_CHIP_CLASS}
              roleLabel={optimizationLabel}
              required
              catalogModels={catalog?.models}
              onClick={() =>
                setEditingModel({
                  config: reflectionModel,
                  onSave: setReflectionModel,
                  label: optimizationLabel,
                  modelDefaultsOnly: nativeProposer,
                })
              }
              onRemove={
                reflectionModel.name ? () => setReflectionModel(emptyModelConfig()) : undefined
              }
            />
          </ModelRoleRow>

          {targetKind === "agent" && (
            <ModelRoleRow
              id="bb-task-model"
              role={agentModelLabel}
              description={msg("submit.blackbox.roles.task.desc")}
              tip={tip("blackbox.config.agent_model")}
            >
              <ModelChip
                config={targetModel}
                modelDefaultsOnly
                className={MOBILE_MODEL_CHIP_CLASS}
                roleLabel={agentModelLabel}
                required
                catalogModels={catalog?.models}
                onClick={() =>
                  setEditingModel({
                    config: targetModel,
                    onSave: setTargetModel,
                    label: agentModelLabel,
                    modelDefaultsOnly: true,
                  })
                }
                onRemove={targetModel.name ? () => setTargetModel(emptyModelConfig()) : undefined}
              />
            </ModelRoleRow>
          )}

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
                min={strategyMode === "auto" ? 5 : 1}
                max={100000}
                step={10}
                className={MOBILE_NUMBER_INPUT_CLASS}
              />
              {strategyMode === "auto" && maxScorerRuns < 5 && (
                <p className="text-xs text-amber-700" role="status">
                  {msg("submit.blackbox.validation.auto_budget")}
                </p>
              )}
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
              />
            </Field>
            {iterationLimitSupported && (
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
                />
              </Field>
            )}
          </div>
        </>
      )}
    </StepCard>
  );
}
