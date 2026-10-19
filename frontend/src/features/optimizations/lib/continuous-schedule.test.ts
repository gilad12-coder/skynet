import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyPreset,
  calendarDay,
  checkTimesOn,
  pickDay,
  pickWeekday,
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

test("a rule reads back as its preset, or custom once its interval changes", () => {
  for (const preset of ["hourly", "daily", "weekdays", "weekly", "monthly"] as const) {
    assert.equal(presetOf(applyPreset(base, preset, "en"), "en"), preset);
  }
  assert.equal(presetOf({ ...base, every: 2 }, "en"), "custom");
  assert.equal(presetOf({ ...base, weekdays: [1, 3] }, "en"), "weekly");
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
  assert.equal(presetOf(hebrew, "en"), "weekly");
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

const RULE = defaultRule("UTC");
// Monday 19 Oct 2026.
const MON = calendarDay(2026, 9, 19);

test("checkTimesOn follows the worker's weekly phase", () => {
  const rule = { ...RULE, every: 2, weekdays: [0, 2] };
  assert.deepEqual(checkTimesOn(rule, MON, MON), ["09:00"]);
  assert.deepEqual(checkTimesOn(rule, calendarDay(2026, 9, 21), MON), ["09:00"]);
  assert.deepEqual(checkTimesOn(rule, calendarDay(2026, 9, 26), MON), []);
  assert.deepEqual(checkTimesOn(rule, calendarDay(2026, 10, 2), MON), ["09:00"]);
});

test("checkTimesOn lists every hourly time and falls back to the month end", () => {
  assert.equal(checkTimesOn({ ...RULE, frequency: "hourly", every: 6 }, MON, MON).length, 4);
  const monthly = { ...RULE, frequency: "monthly" as const, month_day: 31 };
  assert.deepEqual(checkTimesOn(monthly, calendarDay(2026, 10, 30), MON), ["09:00"]);
  assert.deepEqual(checkTimesOn(monthly, calendarDay(2026, 10, 29), MON), []);
});

test("pickDay moves a monthly rule and toggles a weekday", () => {
  assert.equal(pickDay({ ...RULE, frequency: "monthly" }, MON).month_day, 19);
  assert.deepEqual(pickDay({ ...RULE, weekdays: [0, 3] }, MON).weekdays, [3]);
  const daily = pickWeekday({ ...RULE, frequency: "daily", every: 3 }, 6);
  assert.deepEqual([daily.frequency, daily.every, daily.weekdays], ["weekly", 1, [0, 1, 2, 3, 4, 5]]);
  const hourly = { ...RULE, frequency: "hourly" as const };
  assert.equal(pickDay(hourly, MON), hourly);
});
