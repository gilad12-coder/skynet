"use client";

import type { ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";

import { msg } from "@/shared/lib/messages";

import { useSubmitWizard } from "../hooks/use-submit-wizard";
import { slideVariants, emptyModelConfig } from "../constants";
import { PROGRAM_STEP, PROGRAM_STEP_ORDER, type WizardStepId } from "../lib/wizard-steps";
import { SubmitStepper } from "./SubmitStepper";
import { SubmitNav } from "./SubmitNav";
import { SubmitSplash } from "./SubmitSplash";
import { ModelConfigModal } from "./ModelConfigModal";
import { BasicsStep } from "./steps/BasicsStep";
import { DatasetStep } from "./steps/DatasetStep";
import { ModelStep } from "./steps/ModelStep";
import { CodeStep } from "./steps/CodeStep";
import { ParamsStep } from "./steps/ParamsStep";
import { SummaryStep } from "./steps/SummaryStep";
import { SplitSection } from "./steps/SplitSection";

export function SubmitWizard({ header }: { header?: ReactNode }) {
  const w = useSubmitWizard();

  const stepViews: Record<WizardStepId, ReactNode> = {
    basics: <BasicsStep w={w} />,
    cases: <DatasetStep w={w} />,
    start: <CodeStep w={w} part="start" />,
    scorer: <CodeStep w={w} part="scorer" />,
    optimizer: (
      <div className="space-y-4 md:space-y-6">
        <ParamsStep w={w} />
        <ModelStep w={w} />
      </div>
    ),
    split: <SplitSection w={w} />,
    review: <SummaryStep w={w} />,
  };

  // The Starting point and Scorer steps render a two-pane layout with an agent
  // side-panel in auto mode, so they need more horizontal room than the other
  // steps.
  const isCodeStep = w.step === PROGRAM_STEP.start || w.step === PROGRAM_STEP.scorer;
  const stepId = PROGRAM_STEP_ORDER[w.step];
  const containerWidthClass = isCodeStep && w.codeAssistMode === "auto" ? "max-w-5xl" : "max-w-2xl";

  return (
    <div
      className={`mx-auto w-full min-w-0 space-y-4 pb-6 transition-[max-width] duration-300 md:-mt-4 md:space-y-6 md:pb-8 ${containerWidthClass}`}
    >
      <SubmitStepper w={w} />

      {/* The chip belongs to the card beneath it, so it sits closer than the
          column rhythm; the container's shadow padding makes up the rest. */}
      {w.step === PROGRAM_STEP.basics && header && <div className="mb-2">{header}</div>}

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

      <SubmitNav w={w} />

      {/* Model config modal — shared by every model chip AND the workflow
          canvas's dry-run "pick a model in place" flow, so it mounts at the
          wizard root rather than inside the model step. */}
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
        roleLabel={w.editingModel?.label ?? msg("model.generation.label")}
        catalogModels={w.catalog?.models}
        recentConfigs={w.recentConfigs}
        onRemoveRecent={w.removeRecentConfig}
      />

      {/* Submit splash overlay — portal to body so it covers sidebar + header */}
      <SubmitSplash w={w} />
    </div>
  );
}
