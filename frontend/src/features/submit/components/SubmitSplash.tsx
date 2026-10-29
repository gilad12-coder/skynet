"use client";

import { SubmitSplashOverlay } from "@/shared/ui/submit-splash-overlay";

import type { WizardV2Shell } from "../hooks/use-unified-wizard";

export function SubmitSplash({ w }: { w: Pick<WizardV2Shell, "submitPhase"> }) {
  return <SubmitSplashOverlay show={w.submitPhase === "splash" || w.submitPhase === "done"} />;
}
