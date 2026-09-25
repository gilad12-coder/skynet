"use client";

import { WizardStepper } from "@/shared/ui/wizard-stepper";

import { WIZARD_STAGES } from "../constants";
import type { SubmitWizardContext } from "../hooks/use-submit-wizard";

type StepperContext = Pick<
  SubmitWizardContext,
  "step" | "maxReachableStep" | "validateStep" | "handleTabClick"
>;

export function SubmitStepper({
  w,
  locked = false,
}: {
  w: StepperContext;
  /** A running check holds the wizard where it is. */
  locked?: boolean;
}) {
  const { step, maxReachableStep, validateStep, handleTabClick } = w;

  return (
    <WizardStepper
      steps={WIZARD_STAGES.map((s) => ({ id: s.id, label: s.label() }))}
      step={step}
      maxReachableStep={maxReachableStep}
      validateStep={validateStep}
      onSelect={handleTabClick}
      locked={locked}
      tutorial="wizard-stepper"
    />
  );
}
