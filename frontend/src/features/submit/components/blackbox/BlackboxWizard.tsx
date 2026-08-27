"use client";

import type { ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";

import { SubmitSplashOverlay } from "@/shared/ui/submit-splash-overlay";
import { TERMS } from "@/shared/lib/terms";

import { useBlackboxWizard } from "../../hooks/use-blackbox-wizard";
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

export function BlackboxWizard({ header }: { header?: ReactNode }) {
  const w = useBlackboxWizard();

  const steps = [
    <BlackboxBasicsStep key="basics" w={w} />,
    <BlackboxStartStep key="start" w={w} />,
    <BlackboxCasesStep key="cases" w={w} />,
    <BlackboxScorerStep key="scorer" w={w} />,
    <BlackboxOptimizerStep key="optimizer" w={w} />,
    <BlackboxReviewStep key="review" w={w} />,
  ];

  return (
    <div className="mx-auto w-full min-w-0 max-w-2xl space-y-4 pb-6 md:-mt-4 md:space-y-6 md:pb-8">
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
