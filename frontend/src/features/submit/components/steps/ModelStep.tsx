"use client";

import { InlineWarningRow } from "@/shared/ui/inline-warning-row";
import * as React from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/shared/ui/primitives/card";
import { Label } from "@/shared/ui/primitives/label";
import { Separator } from "@/shared/ui/primitives/separator";
import { HelpTip } from "@/shared/ui/help-tip";
import { formatMsg, msg } from "@/shared/lib/messages";
import { tip } from "@/shared/lib/tooltips";
import { TERMS } from "@/shared/lib/terms";
import { ModelChip, AddModelButton } from "@/shared/ui/model-chip";
import { ModelRoleRow } from "../blackbox/ModelRoleRow";

import { emptyModelConfig } from "../../constants";
import type { SubmitWizardContext } from "../../hooks/use-submit-wizard";

const MOBILE_MODEL_CHIP_CLASS =
  "min-h-[44px] max-lg:[&_button]:min-h-[44px] max-lg:[&_button]:min-w-[44px] max-lg:[&_button]:opacity-100";

export function ModelStep({ w }: { w: SubmitWizardContext }) {
  const {
    jobType,
    modelConfig,
    setModelConfig,
    secondModelConfig,
    setSecondModelConfig,
    generationModels,
    setGenerationModels,
    reflectionModels,
    setReflectionModels,
    setEditingModel,
    catalog,
  } = w;

  const requiresOptimizationModel = w.optimizerName.toLowerCase() === "gepa";
  const availableCount = catalog?.models.length ?? 0;
  const catalogEmpty = catalog != null && availableCount === 0;

  return (
    <Card
      className="border-border/50 bg-card/80 backdrop-blur-xl shadow-lg"
      data-tutorial="wizard-step-3"
    >
      <CardHeader className="px-4 sm:px-6">
        <CardTitle className="text-lg">
          {msg("auto.features.submit.components.steps.modelstep.6")}
        </CardTitle>
        <CardDescription>
          {msg("auto.features.submit.components.steps.modelstep.7")}
          {TERMS.optimization}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 px-4 sm:px-6">
        {jobType === "run" ? (
          <div className="space-y-3" data-tutorial="model-catalog">
            <Label className="text-sm font-semibold">
              <HelpTip text={tip("submit.models")}>
                {msg("auto.features.submit.components.steps.modelstep.13")}
              </HelpTip>
            </Label>
            <div className="space-y-2">
              <ModelRoleRow
                role={msg("submit.blackbox.roles.task.label")}
                description={msg("model.generation.explainer")}
              >
                <ModelChip
                  config={modelConfig}
                  className={MOBILE_MODEL_CHIP_CLASS}
                  roleLabel={msg("submit.blackbox.roles.task.label")}
                  required
                  catalogModels={catalog?.models}
                  onClick={() =>
                    setEditingModel({
                      config: modelConfig,
                      onSave: setModelConfig,
                      label: msg("submit.blackbox.roles.task.label"),
                    })
                  }
                  onRemove={modelConfig.name ? () => setModelConfig(emptyModelConfig()) : undefined}
                />
              </ModelRoleRow>
              {requiresOptimizationModel && (
                <ModelRoleRow
                  role={msg("submit.blackbox.roles.optimization.label")}
                  description={msg("model.reflection.explainer")}
                >
                  <ModelChip
                    config={secondModelConfig ?? emptyModelConfig()}
                    className={MOBILE_MODEL_CHIP_CLASS}
                    roleLabel={msg("submit.blackbox.roles.optimization.label")}
                    required
                    catalogModels={catalog?.models}
                    onClick={() =>
                      setEditingModel({
                        config: secondModelConfig ?? emptyModelConfig(),
                        onSave: setSecondModelConfig,
                        label: msg("submit.blackbox.roles.optimization.label"),
                      })
                    }
                    onRemove={
                      secondModelConfig?.name ? () => setSecondModelConfig(null) : undefined
                    }
                  />
                </ModelRoleRow>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-5">
            {catalogEmpty && (
              <InlineWarningRow
                message={msg("auto.features.submit.components.steps.modelstep.14")}
              />
            )}
            <div className="space-y-2">
              <Label className="text-sm font-semibold">
                <HelpTip text={tip("submit.generation_models")}>
                  {msg("model.generation.label_plural")}
                </HelpTip>
              </Label>
              <div className="flex flex-wrap gap-2">
                {generationModels.map((m, i) => (
                  <ModelChip
                    key={i}
                    config={m}
                    className={MOBILE_MODEL_CHIP_CLASS}
                    tooltip={msg("model.generation.explainer")}
                    catalogModels={catalog?.models}
                    onClick={() =>
                      setEditingModel({
                        config: m,
                        onSave: (c) => {
                          const u = [...generationModels];
                          u[i] = c;
                          setGenerationModels(u);
                        },
                        label: `${msg("model.generation.label")} ${i + 1}`,
                      })
                    }
                    onRemove={() => {
                      const next = generationModels.filter((_, j) => j !== i);
                      setGenerationModels(next.length ? next : [emptyModelConfig()]);
                    }}
                  />
                ))}
                {generationModels.every((m) => m.name.trim()) && (
                  <AddModelButton
                    label={msg("auto.features.submit.components.steps.modelstep.literal.7")}
                    className="min-h-[44px]"
                    onClick={() =>
                      setEditingModel({
                        config: generationModels.length
                          ? { ...generationModels[generationModels.length - 1], name: "" }
                          : emptyModelConfig(),
                        onSave: (c) =>
                          setGenerationModels([
                            ...generationModels.filter((m) => m.name.trim()),
                            c,
                          ]),
                        label: msg("model.generation.new"),
                      })
                    }
                  />
                )}
              </div>
            </div>
            <Separator />
            <div className="space-y-2">
              <Label className="text-sm font-semibold">
                <HelpTip text={tip("submit.reflection_models")}>
                  {msg("auto.features.submit.components.steps.modelstep.15")}
                </HelpTip>
              </Label>
              <div className="flex flex-wrap gap-2">
                {reflectionModels.map((m, i) => (
                  <ModelChip
                    key={i}
                    config={m}
                    className={MOBILE_MODEL_CHIP_CLASS}
                    tooltip={msg("model.reflection.explainer")}
                    catalogModels={catalog?.models}
                    onClick={() =>
                      setEditingModel({
                        config: m,
                        onSave: (c) => {
                          const u = [...reflectionModels];
                          u[i] = c;
                          setReflectionModels(u);
                        },
                        label: `${TERMS.reflectionModel} ${i + 1}`,
                      })
                    }
                    onRemove={() => {
                      const next = reflectionModels.filter((_, j) => j !== i);
                      setReflectionModels(next.length ? next : [emptyModelConfig()]);
                    }}
                  />
                ))}
                {reflectionModels.every((m) => m.name.trim()) && (
                  <AddModelButton
                    label={msg("auto.features.submit.components.steps.modelstep.literal.8")}
                    className="min-h-[44px]"
                    onClick={() =>
                      setEditingModel({
                        config: reflectionModels.length
                          ? { ...reflectionModels[reflectionModels.length - 1], name: "" }
                          : emptyModelConfig(),
                        onSave: (c) =>
                          setReflectionModels([
                            ...reflectionModels.filter((m) => m.name.trim()),
                            c,
                          ]),
                        label: formatMsg(
                          "auto.features.submit.components.steps.modelstep.template.2",
                          { p1: TERMS.reflectionModel },
                        ),
                      })
                    }
                  />
                )}
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
