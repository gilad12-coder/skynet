"use client";

import type { ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";

import { msg } from "@/shared/lib/messages";

import { useSubmitWizard } from "../hooks/use-submit-wizard";
import { slideVariants, emptyModelConfig } from "../constants";
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

  const steps = [
    <BasicsStep key="basics" w={w} />,
    <CodeStep key="start" w={w} part="start" />,
    <div key="cases" className="space-y-4 md:space-y-6">
      <DatasetStep w={w} />
      <SplitSection w={w} />
    </div>,
    <CodeStep key="scorer" w={w} part="scorer" />,
    <div key="optimizer" className="space-y-4 md:space-y-6">
      <ParamsStep w={w} />
      <ModelStep w={w} />
    </div>,
    <SummaryStep key="review" w={w} />,
  ];

  // The Starting point (1) and Scorer (3) steps render a two-pane layout with
  // an agent side-panel in auto mode, so they need more horizontal room than
  // the other steps.
  const isCodeStep = w.step === 1 || w.step === 3;
  const containerWidthClass = isCodeStep && w.codeAssistMode === "auto" ? "max-w-5xl" : "max-w-2xl";

  return (
    <div
      className={`mx-auto w-full min-w-0 space-y-4 pb-6 transition-[max-width] duration-300 md:-mt-4 md:space-y-6 md:pb-8 ${containerWidthClass}`}
    >
      <SubmitStepper w={w} />

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
