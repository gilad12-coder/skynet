"use client";

import { Warning } from "@/shared/ui/icons";

import { useWizardV2 } from "../../hooks/use-unified-wizard";
import { stepPages } from "../../lib/wizard-pages";
import { v2Msg } from "./ArtifactConfirmCard";
import { BudgetSection } from "./BudgetSection";
import { ModelsSection } from "./ModelsSection";
import { OptimizerPicker } from "./OptimizerPicker";
import { OptimizerSummary } from "./OptimizerSummary";
import { WizardScreen } from "./WizardScreen";

/**
 * Step 3, Optimizer: which optimizer runs (Auto unless the user picks
 * another), the models it uses and what it may spend. Expert gets the three
 * sections in that order, one screen each, since the models and the budget
 * both follow from the chosen optimizer; Guided and Standard get one summary
 * of the preset choices instead. Every screen stays mounted so the budget's
 * starting limit is set even when only the summary shows.
 */
export function OptimizerStep({ page }: { page: number }) {
  const { state, guided } = useWizardV2();
  const t = (key: string) => v2Msg(key, guided);
  const kind = state.task.artifactKind;
  const mode = state.inputs.mode;
  const choice = state.optimizer.choice;
  const pages = stepPages("optimizer", state);
  const shown = pages[Math.min(page, pages.length - 1)];

  return (
    <div className="flex h-full min-h-0 flex-col gap-5 px-4 py-5 sm:px-6 sm:py-6">
      <header className="flex shrink-0 flex-col gap-1">
        <h3 className="text-base font-semibold text-foreground">
          {t("submit.v2.optimizer.title")}
        </h3>
        <p className="text-sm text-muted-foreground">
          {t(shown === "summary" ? "submit.v2.optimizer.summary.desc" : "submit.v2.optimizer.desc")}
        </p>
      </header>

      {kind && mode ? (
        <>
          <WizardScreen active={shown === "summary"}>
            <OptimizerSummary
              choice={choice}
              canChange={state.level === "standard" && !state.optimizer.expanded}
            />
          </WizardScreen>
          <WizardScreen active={shown === "optimizer"}>
            <OptimizerPicker kind={kind} mode={mode} />
          </WizardScreen>
          <WizardScreen active={shown === "models"}>
            <ModelsSection kind={kind} choice={choice} />
          </WizardScreen>
          <WizardScreen active={shown === "budget"}>
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
