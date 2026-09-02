"use client";

import type { ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";

import { SubmitSplashOverlay } from "@/shared/ui/submit-splash-overlay";
import { TERMS } from "@/shared/lib/terms";

import { useBlackboxWizard, type BlackboxRecipe } from "../../hooks/use-blackbox-wizard";
import { emptyModelConfig, slideVariants } from "../../constants";
import { WIZARD_STAGE, stageAt, type WizardStageId } from "../../lib/wizard-steps";
import { SubmitStepper } from "../SubmitStepper";
import { SubmitNav } from "../SubmitNav";
import { ModelConfigModal } from "../ModelConfigModal";
import { BlackboxBasicsStep } from "./BlackboxBasicsStep";
import { BlackboxStartStep } from "./BlackboxStartStep";
import { BlackboxCasesStep } from "./BlackboxCasesStep";
import { BlackboxScorerStep } from "./BlackboxScorerStep";
import { BlackboxOptimizerStep } from "./BlackboxOptimizerStep";
import { BlackboxReviewStep } from "./BlackboxReviewStep";
import { SplitSection } from "../steps/SplitSection";

export function BlackboxWizard({
  header,
  initialRecipe,
}: {
  header?: ReactNode;
  initialRecipe: BlackboxRecipe;
}) {
  const w = useBlackboxWizard(initialRecipe);

  // Goal and Evaluation widen for the two-pane authoring surface in auto mode;
  // the Evaluation stage's other sections keep the regular column.
  const stageViews: Record<WizardStageId, ReactNode> = {
    goal: <BlackboxStartStep w={w} />,
    evaluation: (
      <div className="space-y-4 md:space-y-6">
        <div className="mx-auto w-full max-w-2xl">
          <BlackboxCasesStep w={w} />
        </div>
        <BlackboxScorerStep w={w} />
        <div className="mx-auto w-full max-w-2xl">
          <SplitSection w={w} />
        </div>
      </div>
    ),
    optimization: <BlackboxOptimizerStep w={w} />,
    review: (
      <div className="space-y-4 md:space-y-6">
        <BlackboxBasicsStep w={w} />
        <BlackboxReviewStep w={w} />
      </div>
    ),
  };

  const isAuthoringStage = w.step === WIZARD_STAGE.goal || w.step === WIZARD_STAGE.evaluation;
  const containerWidthClass =
    isAuthoringStage && w.codeAssistMode === "auto" ? "max-w-5xl" : "max-w-2xl";

  return (
    <div
      className={`mx-auto w-full min-w-0 space-y-4 pb-6 transition-[max-width] duration-300 md:-mt-4 md:space-y-6 md:pb-8 ${containerWidthClass}`}
    >
      <SubmitStepper w={w} />

      {/* The chip belongs to the card beneath it, so it sits closer than the
          column rhythm; the container's shadow padding makes up the rest. */}
      {w.step === WIZARD_STAGE.goal && header && <div className="mb-2">{header}</div>}

      <div className="relative overflow-hidden pt-[10px]" data-tutorial="submit-wizard">
        <AnimatePresence mode="wait" custom={w.direction}>
          <motion.div
            key={w.step}
            custom={w.direction}
            variants={slideVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ duration: 0.1 }}
          >
            {stageViews[stageAt(w.step)]}
          </motion.div>
        </AnimatePresence>
      </div>

      <SubmitNav w={w} />

      <ModelConfigModal
        open={!!w.editingModel}
        onOpenChange={(open) => {
          if (!open) w.setEditingModel(null);
        }}
        config={w.editingModel?.config ?? emptyModelConfig()}
        onSave={(c) => {
          w.editingModel?.onSave(c);
          w.saveToRecent(c);
          w.setEditingModel(null);
        }}
        roleLabel={w.editingModel?.label ?? TERMS.reflectionModel}
        catalogModels={w.catalog?.models}
        recentConfigs={w.recentConfigs}
        onRemoveRecent={w.removeRecentConfig}
        nameOnly={w.editingModel?.nameOnly}
      />

      <SubmitSplashOverlay show={w.submitPhase === "splash" || w.submitPhase === "done"} />
    </div>
  );
}
