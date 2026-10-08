import type { MessageKey } from "@/shared/lib/messages";

import type { ExperienceLevel } from "../lib/abstraction";

/** The message keys that name and describe each level. */
export const LEVEL_KEYS = {
  guided: {
    label: "experience.level.guided.label",
    short: "experience.level.guided.short",
    description: "experience.level.guided.description",
  },
  standard: {
    label: "experience.level.standard.label",
    short: "experience.level.standard.short",
    description: "experience.level.standard.description",
  },
  expert: {
    label: "experience.level.expert.label",
    short: "experience.level.expert.short",
    description: "experience.level.expert.description",
  },
} as const satisfies Record<
  ExperienceLevel,
  { label: MessageKey; short: MessageKey; description: MessageKey }
>;
