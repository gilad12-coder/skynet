"use client";

import { WizardStepper } from "@/shared/ui/wizard-stepper";

import { WIZARD_STAGES } from "../constants";
import type { WizardV2Context } from "../lib/wizard-v2";
import { WIZARD_STAGE, stageAt } from "../lib/wizard-steps";

type StepperContext = Pick<WizardV2Context, "state" | "canEnter" | "stepIssue" | "goTo">;

export function SubmitStepper({
  w,
  locked = false,
}: {
  w: StepperContext;
  /** A running check holds the wizard where it is. */
  locked?: boolean;
}) {
  const { state, canEnter, stepIssue, goTo } = w;
  const step = WIZARD_STAGE[state.step];
  const reachable = WIZARD_STAGES.reduce(
    (furthest, stage, index) => (canEnter(stage.id) ? index : furthest),
    0,
  );

  return (
    <WizardStepper
      steps={WIZARD_STAGES.map((s) => ({ id: s.id, label: s.label() }))}
      step={step}
      maxReachableStep={reachable}
      validateStep={(index) => stepIssue(stageAt(index)) === null}
      onSelect={(index) => goTo(stageAt(index))}
      locked={locked}
      tutorial="wizard-stepper"
    />
  );
}
