/*
 * The setup's tour: after the language, the setup leaves its full-screen
 * panel and walks the real app, one stop per part worth knowing. A stop that
 * owns a setting asks it right in its card. Pure data, so a contract test can
 * check every anchor and every message key without a browser.
 */

import type { NotificationCadence } from "@/shared/lib/api";
import type { MessageKey } from "@/shared/lib/messages";
import type { ModelDataPolicy } from "@/shared/types/api";

import type { IntakeLlmPhase } from "./intake";

/** The settings the tour asks; the language is asked before it, full screen. */
export type SetupQuestion = "level" | IntakeLlmPhase;

export interface SetupStop {
  id: string;
  /** The `data-setup` anchor the spotlight frames; a missing one centers the card. */
  anchor: string;
  title: MessageKey;
  body: MessageKey;
  question?: SetupQuestion;
  /**
   * The Settings tab that holds this stop's setting: the stop opens it and
   * frames the real control, and the card's answer drives that control.
   */
  settings?: string;
}

/** The tour stays short: every stop past this is one the user would skip. */
export const MAX_SETUP_STOPS = 8;

/*
 * The dashboard comes first because the level reshapes it (Guided hides its
 * analytics and the technical columns), so the user sees the answer land.
 * The last stop is the new-optimization entry, which finishing then opens.
 */
export const SETUP_STOPS: readonly SetupStop[] = [
  {
    id: "level",
    anchor: "dashboard",
    title: "experience.level.title",
    body: "experience.level.subtitle",
    question: "level",
  },
  {
    id: "runs",
    anchor: "runs",
    title: "experience.setup.runs.title",
    body: "experience.setup.runs.body",
  },
  {
    id: "billing",
    anchor: "balance",
    title: "experience.intake.billing.title",
    body: "experience.intake.billing.hint",
    question: "billing",
  },
  {
    id: "privacy",
    anchor: "model-privacy",
    settings: "privacy",
    title: "experience.intake.privacy.title",
    body: "experience.intake.privacy.hint",
    question: "privacy",
  },
  {
    id: "emails",
    anchor: "email-updates",
    settings: "privacy",
    title: "experience.intake.emails.title",
    body: "experience.intake.emails.hint",
    question: "emails",
  },
  {
    id: "trust",
    anchor: "agent",
    title: "experience.intake.trust.title",
    body: "experience.intake.trust.hint",
    question: "trust",
  },
  {
    id: "start",
    anchor: "new-optimization",
    title: "experience.setup.start.title",
    body: "experience.setup.start.body",
  },
];

/**
 * Sent on `window` when a setup answer belongs to a setting Settings shows,
 * so the open control takes it (and saves it) as if the user had set it there.
 */
export const SETUP_SETTING_EVENT = "setup-setting";

export type SetupSettingDetail =
  | { privacy: ModelDataPolicy; cadence?: never }
  | { cadence: NotificationCadence; privacy?: never };

export function anchorSelector(anchor: string): string {
  return `[data-setup="${anchor}"]`;
}
