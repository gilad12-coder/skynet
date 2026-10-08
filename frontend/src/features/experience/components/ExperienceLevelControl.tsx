"use client";

import { ArrowCounterClockwise, Gauge } from "@/shared/ui/icons";
import { msg } from "@/shared/lib/messages";
import { Button } from "@/shared/ui/primitives/button";
import { SettingsRow } from "@/shared/ui/settings-row";

import type { ExperienceLevel } from "../lib/abstraction";
import { useExperienceOptional } from "../providers/experience-provider";
import { LEVEL_KEYS } from "./level-keys";
import { LevelSlider } from "./LevelSlider";
import { TOUCH_TAP } from "./touch";

/** The localized name of a level, for the setup's summary row. */
export function levelLabel(level: ExperienceLevel): string {
  return msg(LEVEL_KEYS[level].label);
}

/** The level's longer description, shown under the control for the current choice. */
export function levelDescription(level: ExperienceLevel): string {
  return msg(LEVEL_KEYS[level].description);
}

/**
 * Settings' Guided / Standard / Expert slider and "Run the setup again" —
 * the only place the level changes.
 */
export function ExperienceLevelControl({ onRerun }: { onRerun?: () => void }) {
  const experience = useExperienceOptional();
  if (!experience) return null;
  const { level, loaded, setLevel, rerunIntake } = experience;

  return (
    <>
      <div className="flex items-start gap-3 border-b border-border/40 py-3">
        <Gauge
          className="size-4 mt-0.5 text-muted-foreground shrink-0"
          aria-hidden="true"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium text-foreground">
              {msg("experience.level.title")}
            </span>
            <span className="text-xs text-muted-foreground/80">
              {msg("experience.level.subtitle")}
            </span>
          </div>
          <LevelSlider
            value={level}
            onChange={(next) => void setLevel(next)}
            label={msg("experience.level.title")}
            disabled={!loaded}
          />
          <p className="text-xs text-muted-foreground/80" aria-live="polite">
            {levelDescription(level)}
          </p>
        </div>
      </div>

      <SettingsRow
        icon={ArrowCounterClockwise}
        label={msg("experience.rerun.label")}
        description={msg("experience.rerun.description")}
      >
        <Button
          variant="outline"
          size="sm"
          className={TOUCH_TAP}
          disabled={!loaded}
          onClick={() => {
            onRerun?.();
            rerunIntake();
          }}
        >
          {msg("experience.rerun.action")}
        </Button>
      </SettingsRow>
    </>
  );
}
