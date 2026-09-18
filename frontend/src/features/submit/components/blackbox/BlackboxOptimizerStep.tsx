"use client";

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
import { msg } from "@/shared/lib/messages";
import { Carousel } from "@/features/agent-panel";
import { DEFAULT_PROPOSER, proposerKnobs, proposerTunesReasoning } from "../../lib/engine-contract";

import type { BlackboxHarness, BlackboxProposerEffort } from "@/shared/types/api";
import type { BlackboxWizardContext } from "../../hooks/use-blackbox-wizard";
import { emptyModelConfig } from "../../constants";
import { OPTIMIZATION_MODEL_DESCRIPTION } from "../../lib/model-roles";
import { EngineSlide } from "./EngineSlide";
import { ModelRoleRow } from "./ModelRoleRow";
import {
  Field,
  MOBILE_INPUT_CLASS,
  MOBILE_NUMBER_INPUT_CLASS,
  Segmented,
  StepCard,
} from "./shared";

const PROPOSER_EFFORTS: readonly BlackboxProposerEffort[] = ["low", "medium", "high", "max"];

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
  const selectedEngineIndex = engines.findIndex((e) => e.id === engine);
  const knobs = proposerKnobs(strategyMode, engine);
  const reasoningKnobs = proposerTunesReasoning(proposer.harness);
  const optimizationLabel = msg("submit.blackbox.roles.optimization.label");

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

          {single && (
            <div id="bb-engines" tabIndex={-1} className="@container outline-none">
              {engineCatalog && engines.length === 0 ? (
                <>
                  <Label>
                    <HelpTip text={tip("submit.blackbox.engines")}>
                      {msg("submit.blackbox.engines.label")}
                    </HelpTip>
                  </Label>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {msg("submit.blackbox.engines.none")}
                  </p>
                </>
              ) : (
                <Carousel
                  items={engines}
                  itemKey={(e) => e.id}
                  renderItem={(e) => (
                    <EngineSlide
                      engine={e}
                      selected={engine === e.id}
                      // Only a seed shape the engine cannot take blocks the
                      // choice. An engine that cannot run yet stays selectable
                      // and configurable; Run is what waits for it.
                      blocked={seedMode === "parts" && !e.supports_parts}
                      onChoose={() => setEngine(e.id)}
                    />
                  )}
                  // The field label rides the carousel's own header row,
                  // opposite the position counter, like the module picker.
                  title={
                    <Label>
                      <HelpTip text={tip("submit.blackbox.engines")}>
                        {msg("submit.blackbox.engines.label")}
                      </HelpTip>
                    </Label>
                  }
                  ariaLabel={msg("submit.blackbox.engines.carousel_aria")}
                  jumpIndices={selectedEngineIndex >= 0 ? [selectedEngineIndex] : undefined}
                  followJumps
                  fluid
                />
              )}
            </div>
          )}

          {nativeProposer && (
            // One two-column grid: the harness and its reasoning effort share
            // the first row, and the engine-specific knobs fill in below.
            <div id="bb-proposer" tabIndex={-1} className="grid gap-4 outline-none sm:grid-cols-2">
              <Field
                label={msg("submit.blackbox.proposer.label")}
                htmlFor="bb-proposer-harness"
                tip="submit.blackbox.proposer"
              >
                <Select
                  value={proposer.harness}
                  onValueChange={(value) => updateProposer({ harness: value as BlackboxHarness })}
                >
                  <SelectTrigger
                    id="bb-proposer-harness"
                    className={cn("w-full", MOBILE_INPUT_CLASS)}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {BLACKBOX_HARNESSES.map((h) => (
                      <SelectItem key={h} value={h}>
                        <span className="flex items-center gap-2">
                          <HarnessLogo harness={h} size={16} />
                          <span>{harnessLabel(h)}</span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field
                label={msg("submit.blackbox.proposer.effort")}
                htmlFor="bb-proposer-effort"
                tip="submit.blackbox.proposer_effort"
              >
                <Select
                  value={reasoningKnobs ? (proposer.effort ?? "default") : "default"}
                  disabled={!reasoningKnobs}
                  onValueChange={(value) =>
                    updateProposer({
                      effort: value === "default" ? null : (value as BlackboxProposerEffort),
                    })
                  }
                >
                  <SelectTrigger
                    id="bb-proposer-effort"
                    className={cn("w-full", MOBILE_INPUT_CLASS)}
                  >
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
              {knobs.candidates && (
                <Field
                  label={msg("submit.blackbox.proposer.max_candidates")}
                  htmlFor="bb-proposer-candidates"
                  tip="submit.blackbox.proposer_candidates"
                >
                  <NumberInput
                    id="bb-proposer-candidates"
                    value={
                      proposer.max_candidates_per_iter ??
                      DEFAULT_PROPOSER.max_candidates_per_iter ??
                      ""
                    }
                    onChange={(value) => updateProposer({ max_candidates_per_iter: value })}
                    onClear={() =>
                      updateProposer({
                        max_candidates_per_iter: DEFAULT_PROPOSER.max_candidates_per_iter,
                      })
                    }
                    min={1}
                    max={8}
                    className={MOBILE_NUMBER_INPUT_CLASS}
                  />
                </Field>
              )}
              {knobs.ralph && (
                // A toggle reads as a row, not a column: it takes the full
                // width with its label at the start and the switch at the end.
                <div className="flex min-h-[44px] items-center justify-between gap-3 rounded-lg border border-border/50 bg-background/60 px-3 py-2 sm:col-span-2">
                  <Label htmlFor="bb-proposer-ralph" className="cursor-pointer">
                    <HelpTip text={tip("submit.blackbox.proposer_ralph")}>
                      {msg("submit.blackbox.proposer.ralph")}
                    </HelpTip>
                  </Label>
                  <Switch
                    id="bb-proposer-ralph"
                    checked={proposer.ralph ?? true}
                    onCheckedChange={(checked) => updateProposer({ ralph: checked })}
                    className="relative before:absolute before:-inset-3 before:content-[''] lg:before:hidden"
                  />
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
