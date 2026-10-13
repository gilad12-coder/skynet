import type { MessageKey } from "@/shared/lib/messages";

import type { ExperienceLevel } from "../lib/abstraction";

/** The message keys that name and describe each level. */
export const LEVEL_KEYS = {
  guided: {
    label: "experience.level.guided.label",
    description: "experience.level.guided.description",
  },
  standard: {
    label: "experience.level.standard.label",
    description: "experience.level.standard.description",
  },
  expert: {
    label: "experience.level.expert.label",
    description: "experience.level.expert.description",
  },
} as const satisfies Record<
  ExperienceLevel,
  { label: MessageKey; description: MessageKey }
>;
