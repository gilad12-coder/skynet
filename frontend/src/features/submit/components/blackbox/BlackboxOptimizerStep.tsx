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
import { AddModelButton, ModelChip } from "@/shared/ui/model-chip";
import {
  BLACKBOX_HARNESSES,
  UNAVAILABLE_HARNESSES,
  harnessLabel,
} from "@/shared/lib/blackbox-harness";
import { cn } from "@/shared/lib/utils";
import { tip } from "@/shared/lib/tooltips";
import { msg } from "@/shared/lib/messages";
import { Carousel } from "@/features/agent-panel";
import { useByokKeys } from "@/features/billing";
import {
  AUTO_MIN_SCORER_RUNS,
  DEFAULT_PROPOSER,
  proposerKnobs,
  proposerTunesReasoning,
} from "../../lib/engine-contract";
import { MAX_EXTRA_OPTIMIZATION_MODELS } from "../../lib/shinka-settings";

import type { BlackboxHarness, BlackboxProposerEffort } from "@/shared/types/api";
import type { BlackboxWizardContext } from "../../hooks/use-blackbox-wizard";
import { emptyModelConfig } from "../../constants";
import { OPTIMIZATION_MODEL_DESCRIPTION } from "../../lib/model-roles";
import { EngineSlide } from "./EngineSlide";
import { ModelRoleRow } from "./ModelRoleRow";
import { ShinkaSettingsPanel } from "./ShinkaSettingsPanel";
import { Segmented } from "@/shared/ui/segmented";
import { TOUCH_FIELD } from "@/shared/ui/touch";
import { Field, StepCard } from "./shared";

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
    extraOptimizationModels,
    setExtraOptimizationModels,
    optimizationFamily,
    scorerUsesModel,
    scorerModelMode,
    setEditingModel,
    catalog,
    economyMode,
    setEconomyMode,
  } = w;
  const { keyFor } = useByokKeys();
  // Claude Code proposes only on the user's own verified Anthropic key, and
  // only where the deployment lets its sandbox reach Anthropic.
  const claudeCodeReady =
    engineCatalog?.claude_code_proposer_available === true &&
    keyFor("anthropic")?.status === "verified";

  const engines = engineCatalog?.engines ?? [];
  const single = strategyMode === "single";
  const selectedEngineIndex = engines.findIndex((e) => e.id === engine);
  const knobs = proposerKnobs(strategyMode, engine);
  const reasoningKnobs = proposerTunesReasoning(proposer.harness);
  const optimizationLabel = msg("submit.blackbox.roles.optimization.label");
  const shinka = single && engine === "shinka_evolve";

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
                  <SelectTrigger id="bb-proposer-harness" className={cn("w-full", TOUCH_FIELD)}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {BLACKBOX_HARNESSES.map((h) => {
                      const unavailable = UNAVAILABLE_HARNESSES.includes(h) && !claudeCodeReady;
                      return (
                        <SelectItem key={h} value={h} disabled={unavailable}>
                          <span className="flex items-center gap-2">
                            <HarnessLogo harness={h} size={16} />
                            <span>{harnessLabel(h)}</span>
                            {unavailable && (
                              <span className="text-xs text-muted-foreground">
                                {engineCatalog?.claude_code_proposer_available
                                  ? msg("submit.blackbox.start.harness.claude_code_needs_key")
                                  : msg("submit.blackbox.start.harness.claude_code_unavailable")}
                              </span>
                            )}
                          </span>
                        </SelectItem>
                      );
                    })}
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
                  <SelectTrigger id="bb-proposer-effort" className={cn("w-full", TOUCH_FIELD)}>
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
                  />
                </Field>
              )}
            </div>
          )}

          {runDisabledReason && (
            <p className="flex items-start gap-2 text-xs text-[var(--warning)]" role="status">
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
            {shinka &&
              extraOptimizationModels.map((model, index) => (
                <ModelChip
                  key={index}
                  config={model}
                  className={MOBILE_MODEL_CHIP_CLASS}
                  roleLabel={optimizationLabel}
                  catalogModels={catalog?.models}
                  onClick={() =>
                    setEditingModel({
                      config: model,
                      onSave: (next) =>
                        setExtraOptimizationModels((prev) =>
                          prev.map((m, i) => (i === index ? next : m)),
                        ),
                      label: optimizationLabel,
                    })
                  }
                  onRemove={() =>
                    setExtraOptimizationModels((prev) => prev.filter((_, i) => i !== index))
                  }
                />
              ))}
            {shinka && extraOptimizationModels.length < MAX_EXTRA_OPTIMIZATION_MODELS && (
              <HelpTip text={tip("submit.blackbox.shinka.extra_models")}>
                <AddModelButton
                  label={msg("submit.blackbox.shinka.add_model")}
                  onClick={() =>
                    setEditingModel({
                      config: emptyModelConfig(),
                      onSave: (next) => {
                        if (next.name.trim()) setExtraOptimizationModels((prev) => [...prev, next]);
                      },
                      label: optimizationLabel,
                    })
                  }
                />
              </HelpTip>
            )}
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
                min={strategyMode === "auto" ? AUTO_MIN_SCORER_RUNS : 1}
                max={100000}
                step={10}
              />
              {strategyMode === "auto" && maxScorerRuns < AUTO_MIN_SCORER_RUNS && (
                <p className="text-xs text-[var(--warning)]" role="status">
                  {msg("submit.blackbox.validation.auto_budget")}
                </p>
              )}
            </Field>
            <Field
              label={msg("submit.blackbox.budget.stop_at")}
              htmlFor="bb-stop-at"
              tip="blackbox.config.budget_stop"
            >
              <NumberInput
                id="bb-stop-at"
                value={stopAtScore === "" ? "" : Number(stopAtScore)}
                onChange={(v) => setStopAtScore(String(v))}
                onClear={() => setStopAtScore("")}
                min={0}
                step={0.1}
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
                />
              </Field>
            )}
          </div>

          {(shinka || !single) && <ShinkaSettingsPanel w={w} />}

          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <Label htmlFor="bb-economy-mode" className="cursor-pointer text-sm font-semibold">
                <HelpTip text={tip("submit.economy")}>{msg("submit.economy.label")}</HelpTip>
              </Label>
              <p className="text-xs text-muted-foreground">
                {msg("submit.economy.hint")}
                {nativeProposer && ` ${msg("submit.blackbox.economy.native_hint")}`}
              </p>
            </div>
            <Switch id="bb-economy-mode" checked={economyMode} onCheckedChange={setEconomyMode} />
          </div>
        </>
      )}
    </StepCard>
  );
}
