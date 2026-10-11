"use client";

import { useState, type ReactNode } from "react";
import { motion } from "framer-motion";

import { slideVariants } from "../../constants";
import { ExecutionBudgetProvider } from "../../hooks/use-execution-budget";
import { WizardV2Provider, useWizardV2Shell, v2Text } from "../../hooks/use-unified-wizard";
import { WIZARD_V2_STEPS, type WizardStepId } from "../../lib/wizard-v2";
import { WIZARD_STAGE } from "../../lib/wizard-steps";
import { SubmitNav } from "../SubmitNav";
import { SubmitSplash } from "../SubmitSplash";
import { SubmitStepper } from "../SubmitStepper";
import { InputsStep } from "./InputsStep";
import { MetricStep } from "./MetricStep";
import { OptimizerStep } from "./OptimizerStep";
import { TaskStep } from "./TaskStep";

const STEP_VIEWS: Record<WizardStepId, () => ReactNode> = {
  task: () => <TaskStep />,
  inputs: () => <InputsStep />,
  optimizer: () => <OptimizerStep />,
  metric: () => <MetricStep />,
};

// The task and metric steps hold a chat or a code workspace beside the form.
const WIDE_STEPS = new Set<WizardStepId>(["task", "metric"]);

function UnifiedWizardFrame() {
  const w = useWizardV2Shell();
  const current = w.state.step;
  const index = WIZARD_STAGE[current];
  // The slide direction follows the last move: forward slides one way, back the other.
  const [shownIndex, setShownIndex] = useState(index);
  const [direction, setDirection] = useState(1);
  if (shownIndex !== index) {
    setDirection(index > shownIndex ? 1 : -1);
    setShownIndex(index);
  }
  // Visited steps stay mounted (hidden while inactive) so going back never
  // drops the metric step's agent chat or the code editors' undo history.
  const [visited, setVisited] = useState<ReadonlySet<WizardStepId>>(() => new Set([current]));
  if (!visited.has(current)) setVisited(new Set([...visited, current]));
  const onMetric = current === "metric";
  const runDisabledReason = w.runBlockedReason ? v2Text(w.runBlockedReason, w.guided) : null;

  return (
    <div
      className={`mx-auto w-full min-w-0 space-y-4 pb-6 transition-[max-width] duration-300 md:-mt-4 md:space-y-6 md:pb-8 ${
        WIDE_STEPS.has(current) ? "max-w-6xl" : "max-w-3xl"
      }`}
    >
      <SubmitStepper w={w} locked={w.advancing} />

      <div className="relative overflow-hidden pt-[10px]" data-tutorial="submit-wizard">
        {WIZARD_V2_STEPS.filter((step) => visited.has(step)).map((step) => {
          const active = step === current;
          return (
            <motion.div
              key={step}
              hidden={!active}
              data-tutorial={active ? `wizard-stage-${step}` : undefined}
              custom={direction}
              variants={slideVariants}
              initial="enter"
              animate={active ? "center" : "enter"}
              transition={{ duration: active ? 0.1 : 0 }}
            >
              {STEP_VIEWS[step]()}
            </motion.div>
          );
        })}
      </div>

      <SubmitNav
        w={{ ...w, runDisabledReason }}
        backDisabled={index === 0}
        showSubmit={onMetric}
      />

      <SubmitSplash w={w} />
    </div>
  );
}

/** The one submission wizard: Task, Inputs, Optimizer, Metric, then Run. */
export function UnifiedWizard({ folderId = null }: { folderId?: string | null }) {
  return (
    <ExecutionBudgetProvider>
      <WizardV2Provider folderId={folderId}>
        <UnifiedWizardFrame />
      </WizardV2Provider>
    </ExecutionBudgetProvider>
  );
}
