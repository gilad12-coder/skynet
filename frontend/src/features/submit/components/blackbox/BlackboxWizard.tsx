"use client";

import type { ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";

import { SubmitSplashOverlay } from "@/shared/ui/submit-splash-overlay";
import { TERMS } from "@/shared/lib/terms";

import { useBlackboxWizard, type BlackboxRecipe } from "../../hooks/use-blackbox-wizard";
import { BLACKBOX_STEPS, emptyModelConfig, slideVariants } from "../../constants";
import { ANYTHING_STEP, ANYTHING_STEP_ORDER, type WizardStepId } from "../../lib/wizard-steps";
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

  const stepViews: Record<WizardStepId, ReactNode> = {
    basics: <BlackboxBasicsStep w={w} />,
    start: <BlackboxStartStep w={w} />,
    cases: <BlackboxCasesStep w={w} />,
    scorer: <BlackboxScorerStep w={w} />,
    optimizer: (
      <div className="space-y-4 md:space-y-6">
        <BlackboxOptimizerStep w={w} />
        <SplitSection w={w} />
      </div>
    ),
    review: <BlackboxReviewStep w={w} />,
  };

  // The Starting point and Scorer steps render the two-pane authoring surface
  // with the agent side-panel in auto mode, so they need more horizontal room
  // than the other steps.
  const isAuthoringStep = w.step === ANYTHING_STEP.start || w.step === ANYTHING_STEP.scorer;
  const stepId = ANYTHING_STEP_ORDER[w.step];
  const containerWidthClass =
    isAuthoringStep && w.codeAssistMode === "auto" ? "max-w-5xl" : "max-w-2xl";

  return (
    <div
      className={`mx-auto w-full min-w-0 space-y-4 pb-6 transition-[max-width] duration-300 md:-mt-4 md:space-y-6 md:pb-8 ${containerWidthClass}`}
    >
      <SubmitStepper w={w} steps={BLACKBOX_STEPS} />

      {/* The chip belongs to the card beneath it, so it sits closer than the
          column rhythm; the container's shadow padding makes up the rest. */}
      {w.step === ANYTHING_STEP.basics && header && <div className="mb-2">{header}</div>}

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
            {stepId && stepViews[stepId]}
          </motion.div>
        </AnimatePresence>
      </div>

      <SubmitNav w={w} steps={BLACKBOX_STEPS} />

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
