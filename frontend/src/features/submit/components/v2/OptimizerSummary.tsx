"use client";

import type { ReactNode } from "react";

import { formatCentsUsd } from "@/features/billing";
import { GuidedChoiceLine } from "@/features/experience";
import { useSettingsModal } from "@/features/settings";
import { modelDisplayName } from "@/shared/lib/model-provider";
import { getActiveIntlLocale } from "@/shared/lib/runtime-locale";
import type { ModelConfig } from "@/shared/types/api";
import type { OptimizerChoice } from "@/shared/types/unified-run";
import { Button } from "@/shared/ui/primitives/button";

import { useWizardV2 } from "../../hooks/use-unified-wizard";
import { useModelCatalog } from "../../hooks/use-submit-wizard-data";
import { StepCard } from "../blackbox/shared";
import { v2Msg } from "./ArtifactConfirmCard";
import { optimizerLabel } from "./OptimizerPicker";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-4">
      <dt className="shrink-0 text-xs font-medium text-muted-foreground sm:w-40">{label}</dt>
      <dd className="min-w-0 text-sm text-foreground" dir="auto">
        {children}
      </dd>
    </div>
  );
}

/**
 * The Optimizer step on one read-only screen: the engine, the models and the
 * budget the run will use. Guided gets a line pointing at Settings for more;
 * Standard gets Change, which opens the full engine, models and budget screens.
 */
export function OptimizerSummary({
  choice,
  canChange,
}: {
  choice: OptimizerChoice;
  canChange: boolean;
}) {
  const { state, patchOptimizer, guided, maxCostCents, budgetUncapped } = useWizardV2();
  const t = (key: string, params?: Record<string, string>) => v2Msg(key, guided, params);
  const catalog = useModelCatalog();
  const { openTo } = useSettingsModal();
  const { taskModel, reflectionModel, budget } = state.optimizer;
  const modelName = (config: ModelConfig | null) =>
    config?.name.trim() ? modelDisplayName(config.name, catalog?.models) : null;
  const task = modelName(taskModel);
  const reflection = modelName(reflectionModel);
  const runs = t("submit.v2.optimizer.summary.runs", { p1: String(budget.max_scorer_runs) });
  const limit =
    !budgetUncapped && maxCostCents != null
      ? t("submit.v2.optimizer.summary.limit", {
          p1: formatCentsUsd(maxCostCents, getActiveIntlLocale()),
        })
      : null;

  return (
    <StepCard
      title={t("submit.v2.optimizer.summary.title")}
      trailing={
        canChange ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => patchOptimizer({ expanded: true })}
          >
            {t("submit.v2.optimizer.summary.change")}
          </Button>
        ) : undefined
      }
    >
      <dl className="flex flex-col gap-3" data-testid="optimizer-summary">
        <Row label={t("submit.v2.optimizer.summary.engine")}>{optimizerLabel(choice, guided)}</Row>
        {task && <Row label={t("submit.v2.optimizer.models.task.label")}>{task}</Row>}
        {reflection && (
          <Row label={t("submit.v2.optimizer.models.reflection.label")}>{reflection}</Row>
        )}
        <Row label={t("submit.v2.optimizer.summary.budget")}>
          {limit ? `${runs} · ${limit}` : runs}
        </Row>
      </dl>
      {!canChange && guided && (
        <GuidedChoiceLine
          className="mt-4"
          text={t("submit.v2.optimizer.summary.guided_line")}
          onShowMore={() => openTo("account")}
        />
      )}
    </StepCard>
  );
}
