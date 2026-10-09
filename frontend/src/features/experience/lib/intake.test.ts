import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SKIP_PATCH,
  buildExperiencePatch,
  buildNotificationPatch,
  emptyIntake,
  notificationsFromPrefs,
  parseIntakeAnswers,
} from "./intake.ts";

test("buildExperiencePatch finishes the setup with the chosen level and the answers", () => {
  const answers = { ...emptyIntake(), billing: "byok" as const, level: "expert" as const };
  const patch = buildExperiencePatch(answers);
  assert.equal(patch.level, "expert");
  assert.equal(patch.intake_completed, true);
  assert.equal((patch.intake as Record<string, unknown>).billing, "byok");
  assert.equal((patch.intake as Record<string, unknown>).version, 1);
  assert.deepEqual(SKIP_PATCH, { level: "standard", intake_completed: true });
});

test("buildNotificationPatch only sends Live's sub-settings with Live", () => {
  const base = emptyIntake().notifications;
  assert.deepEqual(buildNotificationPatch(base), {
    cadence: "done",
    stuck_fraction: 0.25,
    budget_alert_fraction: 0.8,
  });
  assert.deepEqual(
    buildNotificationPatch({ ...base, cadence: "live", live_mode: "per_run_count", live_count: 5 }),
    {
      cadence: "live",
      stuck_fraction: 0.25,
      budget_alert_fraction: 0.8,
      live_mode: "per_run_count",
      live_count: 5,
    },
  );
  const digest = buildNotificationPatch({
    ...base,
    cadence: "live",
    live_mode: "digest",
    digest_minutes: 120,
  });
  assert.equal(digest.digest_minutes, 120);
  assert.equal(digest.live_count, undefined);
});

test("parseIntakeAnswers round-trips stored answers and clamps out-of-range numbers", () => {
  const stored = buildExperiencePatch({
    ...emptyIntake(),
    privacy: "zdr",
    spending_limit_cents: 500,
  }).intake;
  const parsed = parseIntakeAnswers(stored);
  assert.equal(parsed?.privacy, "zdr");
  assert.equal(parsed?.spending_limit_cents, 500);
  const clamped = parseIntakeAnswers({
    notifications: { live_count: 99, stuck_fraction: 0, cadence: "hourly" },
  });
  assert.equal(clamped?.notifications.live_count, 20);
  assert.equal(clamped?.notifications.stuck_fraction, 0.05);
  assert.equal(clamped?.notifications.cadence, "done");
  assert.equal(parseIntakeAnswers(null), null);
  assert.equal(parseIntakeAnswers([1]), null);
});

test("notificationsFromPrefs fills server gaps with the defaults", () => {
  assert.deepEqual(notificationsFromPrefs(null), emptyIntake().notifications);
  assert.equal(notificationsFromPrefs({ cadence: "milestones" }).cadence, "milestones");
});
