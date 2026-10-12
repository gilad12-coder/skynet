"use client";

import { WizardStepper } from "@/shared/ui/wizard-stepper";

import { WIZARD_STAGES } from "../constants";
import type { WizardV2Context } from "../lib/wizard-v2";

type StepperContext = Pick<WizardV2Context, "state" | "steps" | "canEnter" | "stepIssue" | "goTo">;

export function SubmitStepper({
  w,
  locked = false,
}: {
  w: StepperContext;
  /** A running check holds the wizard where it is. */
  locked?: boolean;
}) {
  const { state, steps, canEnter, stepIssue, goTo } = w;
  // Only the steps this wizard walks: Guided's skipped Optimizer step leaves no dot.
  const stages = WIZARD_STAGES.filter((stage) => steps.includes(stage.id));
  const step = Math.max(0, steps.indexOf(state.step));
  const reachable = stages.reduce(
    (furthest, stage, index) => (canEnter(stage.id) ? index : furthest),
    0,
  );

  return (
    <WizardStepper
      steps={stages.map((s) => ({ id: s.id, label: s.label() }))}
      step={step}
      maxReachableStep={reachable}
      validateStep={(index) => stepIssue(stages[index]?.id ?? state.step) === null}
      onSelect={(index) => {
        const target = stages[index];
        if (target) goTo(target.id);
      }}
      locked={locked}
      tutorial="wizard-stepper"
    />
  );
}
