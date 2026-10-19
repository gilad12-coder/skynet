"use client";

import { useEffect, useMemo, useState } from "react";
import { Input } from "@/shared/ui/primitives/input";
import { Label } from "@/shared/ui/primitives/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/primitives/select";
import { NumberInput } from "@/shared/ui/number-input";
import { Segmented } from "@/shared/ui/segmented";
import { formatMsg, msg, type MessageKey } from "@/shared/lib/messages";
import { getActiveIntlLocale } from "@/shared/lib/runtime-locale";
import { previewContinuousSchedule } from "@/shared/lib/api";
import type { ScheduleFrequency, ScheduleRule } from "@/shared/types/continuous";
import { cn } from "@/shared/lib/utils";
import {
  FREQUENCIES,
  MAX_EVERY,
  PRESETS,
  applyPreset,
  presetOf,
  scheduleProblem,
  scheduleSummary,
  timeZoneOptions,
  toggleWeekday,
  weekdayNames,
  weekdayOrder,
  type SchedulePreset,
} from "../lib/continuous-schedule";

const PRESET_KEYS: Record<SchedulePreset, MessageKey> = {
  hourly: "continuous_tab.schedule.preset.hourly",
  daily: "continuous_tab.schedule.preset.daily",
  weekdays: "continuous_tab.schedule.preset.weekdays",
  weekly: "continuous_tab.schedule.preset.weekly",
  monthly: "continuous_tab.schedule.preset.monthly",
  custom: "continuous_tab.schedule.preset.custom",
};

const UNIT_KEYS: Record<ScheduleFrequency, MessageKey> = {
  hourly: "continuous_tab.schedule.unit.hourly",
  daily: "continuous_tab.schedule.unit.daily",
  weekly: "continuous_tab.schedule.unit.weekly",
  monthly: "continuous_tab.schedule.unit.monthly",
};

const PREVIEW_DELAY_MS = 300;

/** The rule in words, with its time zone. */
export function describeSchedule(rule: ScheduleRule): string {
  const { key, params } = scheduleSummary(rule, getActiveIntlLocale());
  return formatMsg("continuous_tab.schedule.in_zone", {
    schedule: formatMsg(key, params),
    timezone: rule.timezone,
  });
}

/** Format a check time in the plan's zone, so it reads like the rule. */
export function formatCheck(iso: string, timezone: string): string {
  return new Date(iso).toLocaleString(getActiveIntlLocale(), {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  });
}

/**
 * When a continuous plan checks, edited the way automation tools do it:
 * one-click presets, then "every N hours/days/weeks/months" with the days,
 * time and time zone, a plain-language summary and the next three check
 * times from the server.
 */
export function ScheduleEditor({
  value,
  onChange,
  idPrefix,
}: {
  value: ScheduleRule;
  onChange: (rule: ScheduleRule) => void;
  idPrefix: string;
}) {
  const locale = getActiveIntlLocale();
  const preset = presetOf(value, locale);
  const dayOrder = useMemo(() => weekdayOrder(locale), [locale]);
  const problem = scheduleProblem(value);
  const shortDays = useMemo(() => weekdayNames(locale, "short"), [locale]);
  const longDays = useMemo(() => weekdayNames(locale, "long"), [locale]);
  const zones = useMemo(() => timeZoneOptions(value.timezone), [value.timezone]);
  const [preview, setPreview] = useState<{ key: string; times: string[] | null } | null>(null);
  const ruleKey = JSON.stringify(value);

  useEffect(() => {
    if (problem) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      previewContinuousSchedule(value)
        .then((res) => {
          if (!cancelled) setPreview({ key: ruleKey, times: res.next_checks });
        })
        .catch(() => {
          if (!cancelled) setPreview({ key: ruleKey, times: null });
        });
    }, PREVIEW_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [value, ruleKey, problem]);

  const set = (patch: Partial<ScheduleRule>) => onChange({ ...value, ...patch });
  const hourly = value.frequency === "hourly";
  const current = preview?.key === ruleKey ? preview.times : undefined;

  return (
    <div className="space-y-4">
      <Segmented
        value={preset}
        onChange={(next) => onChange(applyPreset(value, next, locale))}
        label={msg("continuous_tab.schedule.label")}
        size="sm"
        className="flex-wrap"
        options={PRESETS.map((p) => ({ value: p, label: msg(PRESET_KEYS[p]) }))}
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-every`}>{msg("continuous_tab.schedule.every")}</Label>
          <div className="flex gap-2">
            <NumberInput
              id={`${idPrefix}-every`}
              value={value.every}
              min={1}
              max={MAX_EVERY[value.frequency]}
              onChange={(every) => set({ every })}
              className="w-28"
            />
            <Select
              value={value.frequency}
              onValueChange={(frequency) => {
                const next = frequency as ScheduleFrequency;
                set({
                  frequency: next,
                  every: Math.min(value.every, MAX_EVERY[next]),
                  weekdays: next === "weekly" && value.weekdays.length === 0 ? [0] : value.weekdays,
                });
              }}
            >
              <SelectTrigger className="flex-1" aria-label={msg("continuous_tab.schedule.unit")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FREQUENCIES.map((f) => (
                  <SelectItem key={f} value={f}>
                    {msg(UNIT_KEYS[f])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-time`}>
            {msg(hourly ? "continuous_tab.schedule.start_at" : "continuous_tab.schedule.at")}
          </Label>
          <Input
            id={`${idPrefix}-time`}
            type="time"
            dir="ltr"
            required
            value={value.time}
            onChange={(e) => set({ time: e.target.value })}
          />
        </div>

        {value.frequency === "weekly" && (
          <fieldset className="space-y-1.5 sm:col-span-2">
            <legend className="mb-1.5 text-sm font-medium">
              {msg("continuous_tab.schedule.on")}
            </legend>
            <div className="flex flex-wrap gap-1.5">
              {dayOrder.map((day) => {
                const on = value.weekdays.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    aria-pressed={on}
                    aria-label={longDays[day]}
                    onClick={() => set({ weekdays: toggleWeekday(value.weekdays, day) })}
                    className={cn(
                      "min-w-11 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      on
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background text-muted-foreground hover:bg-muted",
                    )}
                  >
                    {shortDays[day]}
                  </button>
                );
              })}
            </div>
          </fieldset>
        )}

        {value.frequency === "monthly" && (
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-day`}>{msg("continuous_tab.schedule.on_day")}</Label>
            <NumberInput
              id={`${idPrefix}-day`}
              value={value.month_day}
              min={1}
              max={31}
              onChange={(month_day) => set({ month_day })}
              className="w-28"
            />
            {value.month_day > 28 && (
              <p className="text-xs text-muted-foreground">
                {msg("continuous_tab.schedule.month_end")}
              </p>
            )}
          </div>
        )}

        <div className={cn("space-y-1.5", value.frequency !== "monthly" && "sm:col-span-2")}>
          <Label htmlFor={`${idPrefix}-zone`}>{msg("continuous_tab.schedule.timezone")}</Label>
          <Select value={value.timezone} onValueChange={(timezone) => set({ timezone })}>
            <SelectTrigger id={`${idPrefix}-zone`} className="sm:max-w-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-72">
              {zones.map((zone) => (
                <SelectItem key={zone} value={zone}>
                  <bdi>{zone.replaceAll("_", " ")}</bdi>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="rounded-lg border border-border/60 bg-muted/40 px-3.5 py-3 text-sm">
        {problem ? (
          <p className="text-[var(--warning)]">{msg(problem)}</p>
        ) : (
          <>
            <p className="font-medium">{describeSchedule(value)}</p>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {msg("continuous_tab.schedule.next_checks")}
            </p>
            {current === null ? (
              <p className="text-xs text-muted-foreground">
                {msg("continuous_tab.schedule.preview_failed")}
              </p>
            ) : (
              <ul className="mt-0.5 space-y-0.5 text-xs" aria-busy={current === undefined}>
                {(current ?? []).map((iso) => (
                  <li key={iso}>{formatCheck(iso, value.timezone)}</li>
                ))}
                {current === undefined && <li className="text-muted-foreground">…</li>}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}
