"use client";

import { Warning } from "@/shared/ui/icons";

import { useWizardV2 } from "../../hooks/use-unified-wizard";
import { v2Msg } from "./ArtifactConfirmCard";
import { BudgetSection } from "./BudgetSection";
import { ModelsSection } from "./ModelsSection";
import { OptimizerPicker } from "./OptimizerPicker";

/**
 * Step 3, Optimizer: which optimizer runs (Auto unless the user picks
 * another), the models it uses and what it may spend. The three sections
 * stack in that order, since the models and the budget both follow from the
 * chosen optimizer.
 */
export function OptimizerStep() {
  const { state, guided } = useWizardV2();
  const t = (key: string) => v2Msg(key, guided);
  const kind = state.task.artifactKind;
  const mode = state.inputs.mode;
  const choice = state.optimizer.choice;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 px-4 py-5 sm:px-6 sm:py-6">
      <header className="flex flex-col gap-1">
        <h3 className="text-base font-semibold text-foreground">
          {t("submit.v2.optimizer.title")}
        </h3>
        <p className="text-sm text-muted-foreground">{t("submit.v2.optimizer.desc")}</p>
      </header>

      {kind && mode ? (
        <>
          <OptimizerPicker kind={kind} mode={mode} />
          <ModelsSection kind={kind} choice={choice} />
          <BudgetSection kind={kind} choice={choice} />
        </>
      ) : (
        <p className="flex items-start gap-2 text-sm text-muted-foreground" role="status">
          <Warning className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{t("submit.v2.optimizer.needs_setup")}</span>
        </p>
      )}
    </div>
  );
}
