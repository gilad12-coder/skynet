"use client";

import { Warning } from "@/shared/ui/icons";

import { useWizardV2 } from "../../hooks/use-unified-wizard";
import { v2Msg } from "./ArtifactConfirmCard";
import { BudgetSection } from "./BudgetSection";
import { ModelsSection } from "./ModelsSection";
import { OptimizerPicker } from "./OptimizerPicker";
import { WizardScreen } from "./WizardScreen";

/**
 * Step 3, Optimizer: which optimizer runs (Auto unless the user picks
 * another), the models it uses and what it may spend. The three sections
 * come in that order, one screen each, since the models and the budget both
 * follow from the chosen optimizer.
 */
export function OptimizerStep({ page }: { page: number }) {
  const { state, guided } = useWizardV2();
  const t = (key: string) => v2Msg(key, guided);
  const kind = state.task.artifactKind;
  const mode = state.inputs.mode;
  const choice = state.optimizer.choice;

  return (
    <div className="flex h-full min-h-0 flex-col gap-5 px-4 py-5 sm:px-6 sm:py-6">
      <header className="flex shrink-0 flex-col gap-1">
        <h3 className="text-base font-semibold text-foreground">
          {t("submit.v2.optimizer.title")}
        </h3>
        <p className="text-sm text-muted-foreground">{t("submit.v2.optimizer.desc")}</p>
      </header>

      {kind && mode ? (
        <>
          <WizardScreen active={page === 0}>
            <OptimizerPicker kind={kind} mode={mode} />
          </WizardScreen>
          <WizardScreen active={page === 1}>
            <ModelsSection kind={kind} choice={choice} />
          </WizardScreen>
          <WizardScreen active={page === 2}>
            <BudgetSection kind={kind} choice={choice} />
          </WizardScreen>
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
