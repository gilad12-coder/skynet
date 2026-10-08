"use client";

import * as React from "react";

import { msg, type MessageKey } from "@/shared/lib/messages";
import type { NotificationCadence, NotificationLiveMode } from "@/shared/lib/api";
import { Label } from "@/shared/ui/primitives/label";
import { NumberInput } from "@/shared/ui/number-input";
import { Segmented, type SegmentedOption } from "@/shared/ui/segmented";

import type { IntakeNotifications } from "../lib/intake";

const CADENCE_KEYS = {
  done: { label: "experience.notify.cadence.done", tip: "experience.notify.cadence.done_tip" },
  milestones: {
    label: "experience.notify.cadence.milestones",
    tip: "experience.notify.cadence.milestones_tip",
  },
  live: { label: "experience.notify.cadence.live", tip: "experience.notify.cadence.live_tip" },
} as const satisfies Record<NotificationCadence, { label: MessageKey; tip: MessageKey }>;

const LIVE_MODE_KEYS = {
  per_stage: "experience.notify.live.per_stage",
  per_run_count: "experience.notify.live.per_run_count",
  digest: "experience.notify.live.digest",
} as const satisfies Record<NotificationLiveMode, MessageKey>;

const toPercent = (fraction: number) => Math.round(fraction * 100);

/**
 * How often run emails arrive: Only when done / Milestones / Live, Live's
 * sub-mode with its number, and the two milestone thresholds. Shared by the
 * first-login setup's summary and Settings, so both read and write one shape.
 */
export function NotificationCadenceFields({
  value,
  onChange,
  disabled = false,
  idPrefix,
}: {
  value: IntakeNotifications;
  onChange: (patch: Partial<IntakeNotifications>) => void;
  disabled?: boolean;
  idPrefix: string;
}) {
  const cadenceOptions: Array<SegmentedOption<NotificationCadence>> = (
    Object.keys(CADENCE_KEYS) as NotificationCadence[]
  ).map((cadence) => ({
    value: cadence,
    label: msg(CADENCE_KEYS[cadence].label),
    disabled,
  }));
  const liveOptions: Array<SegmentedOption<NotificationLiveMode>> = (
    Object.keys(LIVE_MODE_KEYS) as NotificationLiveMode[]
  ).map((mode) => ({ value: mode, label: msg(LIVE_MODE_KEYS[mode]), disabled }));

  const countId = `${idPrefix}-live-count`;
  const digestId = `${idPrefix}-digest`;
  const stuckId = `${idPrefix}-stuck`;
  const budgetId = `${idPrefix}-budget`;

  return (
    <div className="flex flex-col gap-2">
      <Segmented<NotificationCadence>
        value={value.cadence}
        onChange={(cadence) => onChange({ cadence })}
        options={cadenceOptions}
        label={msg("experience.notify.cadence.label")}
        size="sm"
        className="w-full"
      />
      <p className="text-xs text-muted-foreground/80" aria-live="polite">
        {msg(CADENCE_KEYS[value.cadence].tip)}
      </p>

      {value.cadence === "live" && (
        <div className="flex flex-col gap-2">
          <Segmented<NotificationLiveMode>
            value={value.live_mode}
            onChange={(live_mode) => onChange({ live_mode })}
            options={liveOptions}
            label={msg("experience.notify.live.label")}
            size="sm"
            className="w-full"
          />
          {value.live_mode === "per_run_count" && (
            <NumberRow id={countId} label={msg("experience.notify.live.count_label")}>
              <NumberInput
                id={countId}
                size="sm"
                className="w-32"
                value={value.live_count}
                min={1}
                max={20}
                disabled={disabled}
                onChange={(live_count) => onChange({ live_count })}
              />
            </NumberRow>
          )}
          {value.live_mode === "digest" && (
            <NumberRow id={digestId} label={msg("experience.notify.live.digest_label")}>
              <NumberInput
                id={digestId}
                size="sm"
                className="w-32"
                value={value.digest_minutes}
                min={15}
                max={1440}
                step={15}
                disabled={disabled}
                onChange={(digest_minutes) => onChange({ digest_minutes })}
              />
            </NumberRow>
          )}
        </div>
      )}

      {value.cadence !== "done" && (
        <div className="flex flex-col gap-2 border-t border-border/60 pt-2">
          <span className="text-xs font-medium text-muted-foreground">
            {msg("experience.notify.thresholds.label")}
          </span>
          <NumberRow id={stuckId} label={msg("experience.notify.thresholds.stuck")}>
            <NumberInput
              id={stuckId}
              size="sm"
              className="w-32"
              value={toPercent(value.stuck_fraction)}
              min={5}
              max={100}
              step={5}
              disabled={disabled}
              onChange={(percent) => onChange({ stuck_fraction: percent / 100 })}
            />
          </NumberRow>
          <NumberRow id={budgetId} label={msg("experience.notify.thresholds.budget")}>
            <NumberInput
              id={budgetId}
              size="sm"
              className="w-32"
              value={toPercent(value.budget_alert_fraction)}
              min={10}
              max={100}
              step={5}
              disabled={disabled}
              onChange={(percent) => onChange({ budget_alert_fraction: percent / 100 })}
            />
          </NumberRow>
        </div>
      )}
    </div>
  );
}

function NumberRow({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Label htmlFor={id} className="text-xs font-normal text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}
