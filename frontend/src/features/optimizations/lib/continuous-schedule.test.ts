import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyPreset,
  defaultRule,
  presetOf,
  scheduleProblem,
  scheduleSummary,
  timeZoneOptions,
  toggleWeekday,
  weekdayNames,
  weekdayOrder,
  workweek,
} from "./continuous-schedule.ts";

const base = defaultRule("Europe/Berlin");

test("presets set the frequency and keep the chosen time and zone", () => {
  const at = { ...base, time: "18:30" };
  const weekdays = applyPreset(at, "weekdays", "en");
  assert.deepEqual(weekdays.weekdays, [0, 1, 2, 3, 4]);
  assert.equal(weekdays.frequency, "weekly");
  assert.equal(weekdays.time, "18:30");
  assert.equal(weekdays.timezone, "Europe/Berlin");
  assert.equal(applyPreset({ ...at, every: 3 }, "daily", "en").every, 1);
  assert.equal(applyPreset(weekdays, "weekly", "en").weekdays.length, 1);
});

test("a rule reads back as its preset, or custom once edited", () => {
  for (const preset of ["hourly", "daily", "weekdays", "weekly", "monthly"] as const) {
    assert.equal(presetOf(applyPreset(base, preset, "en"), "en"), preset);
  }
  assert.equal(presetOf({ ...base, every: 2 }, "en"), "custom");
  assert.equal(presetOf({ ...base, weekdays: [1, 3] }, "en"), "custom");
});

test("weekday toggles stay sorted and unique", () => {
  assert.deepEqual(toggleWeekday([0, 4], 2), [0, 2, 4]);
  assert.deepEqual(toggleWeekday([0, 2, 4], 2), [0, 4]);
});

test("impossible rules are named like the backend refuses them", () => {
  assert.equal(scheduleProblem(base), null);
  assert.equal(
    scheduleProblem({ ...base, weekdays: [] }),
    "continuous_tab.schedule.problem.weekday",
  );
  assert.equal(
    scheduleProblem({ ...base, frequency: "hourly", every: 13 }),
    "continuous_tab.schedule.problem.every",
  );
  assert.equal(scheduleProblem({ ...base, every: 0 }), "continuous_tab.schedule.problem.every");
  assert.equal(scheduleProblem({ ...base, time: "9:00" }), "continuous_tab.schedule.problem.time");
  assert.equal(
    scheduleProblem({ ...base, frequency: "monthly", month_day: 32 }),
    "continuous_tab.schedule.problem.day",
  );
});

test("the summary names the days and time in the active locale", () => {
  assert.deepEqual(scheduleSummary(applyPreset(base, "weekdays", "en-GB"), "en-GB"), {
    key: "continuous_tab.schedule.summary.weekdays",
    params: { time: "09:00" },
  });
  const twoDays = scheduleSummary({ ...base, every: 2, weekdays: [0, 3], time: "14:05" }, "en-US");
  assert.equal(twoDays.key, "continuous_tab.schedule.summary.weekly");
  assert.deepEqual(twoDays.params, { every: 2, days: "Monday and Thursday", time: "2:05 PM" });
  assert.deepEqual(scheduleSummary({ ...base, frequency: "hourly", time: "03:15" }, "en").params, {
    every: 1,
    minute: "15",
  });
  assert.equal(
    scheduleSummary({ ...base, frequency: "monthly", month_day: 31 }, "en").params.day,
    31,
  );
});

test("weekdays and the week's first day follow the locale", () => {
  assert.deepEqual(workweek("en"), [0, 1, 2, 3, 4]);
  assert.deepEqual(workweek("he"), [0, 1, 2, 3, 6]);
  const hebrew = applyPreset(base, "weekdays", "he");
  assert.equal(presetOf(hebrew, "he"), "weekdays");
  assert.equal(presetOf(hebrew, "en"), "custom");
  assert.equal(scheduleSummary(hebrew, "he").key, "continuous_tab.schedule.summary.weekdays");
  assert.deepEqual(weekdayOrder("he"), [6, 0, 1, 2, 3, 4, 5]);
  assert.deepEqual(weekdayOrder("de"), [0, 1, 2, 3, 4, 5, 6]);
});

test("weekday names start on Monday", () => {
  assert.equal(weekdayNames("en", "long")[0], "Monday");
  assert.equal(weekdayNames("en", "long")[6], "Sunday");
});

test("the current zone is always selectable", () => {
  const zones = timeZoneOptions("Etc/Unknown-Zone");
  assert.equal(zones[0], "Etc/Unknown-Zone");
  assert.ok(timeZoneOptions("UTC").includes("UTC"));
});
