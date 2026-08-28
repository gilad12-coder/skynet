"use client";

import type { ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";

import { SubmitSplashOverlay } from "@/shared/ui/submit-splash-overlay";
import { TERMS } from "@/shared/lib/terms";

import { useBlackboxWizard, type BlackboxRecipe } from "../../hooks/use-blackbox-wizard";
import { BLACKBOX_STEPS, emptyModelConfig, slideVariants } from "../../constants";
import { SubmitStepper } from "../SubmitStepper";
import { SubmitNav } from "../SubmitNav";
import { ModelConfigModal } from "../ModelConfigModal";
import { BlackboxBasicsStep } from "./BlackboxBasicsStep";
import { BlackboxStartStep } from "./BlackboxStartStep";
import { BlackboxCasesStep } from "./BlackboxCasesStep";
import { BlackboxScorerStep } from "./BlackboxScorerStep";
import { BlackboxOptimizerStep } from "./BlackboxOptimizerStep";
import { BlackboxReviewStep } from "./BlackboxReviewStep";

export function BlackboxWizard({ header, recipe }: { header?: ReactNode; recipe: BlackboxRecipe }) {
  const w = useBlackboxWizard(recipe);

  const steps = [
    <BlackboxBasicsStep key="basics" w={w} />,
    <BlackboxStartStep key="start" w={w} />,
    <BlackboxCasesStep key="cases" w={w} />,
    <BlackboxScorerStep key="scorer" w={w} />,
    <BlackboxOptimizerStep key="optimizer" w={w} />,
    <BlackboxReviewStep key="review" w={w} />,
  ];

  // The Starting point (1) and Scorer (3) steps render the two-pane authoring
  // surface with the agent side-panel in auto mode, so they need more
  // horizontal room than the other steps.
  const isAuthoringStep = w.step === 1 || w.step === 3;
  const containerWidthClass =
    isAuthoringStep && w.codeAssistMode === "auto" ? "max-w-5xl" : "max-w-2xl";

  return (
    <div
      className={`mx-auto w-full min-w-0 space-y-4 pb-6 transition-[max-width] duration-300 md:-mt-4 md:space-y-6 md:pb-8 ${containerWidthClass}`}
    >
      <SubmitStepper w={w} steps={BLACKBOX_STEPS} />

      {w.step === 0 && header}

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
            {steps[w.step]}
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
      />

      <SubmitSplashOverlay show={w.submitPhase === "splash" || w.submitPhase === "done"} />
    </div>
  );
}
