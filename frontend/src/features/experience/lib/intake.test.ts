import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SKIP_PATCH,
  agentBrief,
  buildExperiencePatch,
  buildNotificationPatch,
  buildWizardPrefill,
  classifySourceText,
  emptyIntake,
  inferLevel,
  notificationsFromPrefs,
  parseIntakeAnswers,
  recipeFor,
} from "./intake.ts";

test("classifySourceText recognises GitHub links, bare owner/name and HTTP endpoints", () => {
  assert.deepEqual(classifySourceText("https://github.com/acme/router.git"), {
    kind: "repo",
    value: "acme/router",
  });
  assert.deepEqual(classifySourceText("github.com/acme/router/tree/main"), {
    kind: "repo",
    value: "acme/router",
  });
  assert.deepEqual(classifySourceText("acme/router"), { kind: "repo", value: "acme/router" });
  assert.deepEqual(classifySourceText("https://api.acme.dev/score"), {
    kind: "api",
    value: "https://api.acme.dev/score",
  });
  assert.equal(classifySourceText("my spreadsheet"), null);
  assert.equal(classifySourceText("  "), null);
});

test("inferLevel: data without code is Guided, repo/API is Standard, engine talk is Expert", () => {
  assert.equal(inferLevel({ goal: "sort tickets better", source: "spreadsheet" }), "guided");
  assert.equal(inferLevel({ goal: "sort tickets better", source: "dataset" }), "guided");
  assert.equal(inferLevel({ goal: "sort tickets better", source: null }), "guided");
  assert.equal(inferLevel({ goal: "pass more tests", source: "repo" }), "standard");
  assert.equal(inferLevel({ goal: "pass more tests", source: "api" }), "standard");
  assert.equal(inferLevel({ goal: "run GEPA with temperature 0.2", source: "file" }), "expert");
  assert.equal(inferLevel({ goal: "try ShinkaEvolve islands", source: "repo" }), "expert");
});

test("each source implies one recipe", () => {
  assert.equal(recipeFor("repo"), "repo");
  assert.equal(recipeFor("api"), "anything");
  assert.equal(recipeFor("spreadsheet"), "program");
  assert.equal(recipeFor(null), "program");
});

test("buildExperiencePatch finishes the setup with the chosen level and the answers", () => {
  const answers = { ...emptyIntake(), goal: "route tickets", source: "repo" as const, level: "expert" as const };
  const patch = buildExperiencePatch(answers);
  assert.equal(patch.level, "expert");
  assert.equal(patch.intake_completed, true);
  assert.equal((patch.intake as Record<string, unknown>).goal, "route tickets");
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
  const digest = buildNotificationPatch({ ...base, cadence: "live", live_mode: "digest", digest_minutes: 120 });
  assert.equal(digest.digest_minutes, 120);
  assert.equal(digest.live_count, undefined);
});

test("parseIntakeAnswers round-trips stored answers and clamps out-of-range numbers", () => {
  const stored = buildExperiencePatch({
    ...emptyIntake(),
    goal: "g",
    source: "api",
    spending_limit_cents: 500,
  }).intake;
  const parsed = parseIntakeAnswers(stored);
  assert.equal(parsed?.source, "api");
  assert.equal(parsed?.spending_limit_cents, 500);
  const clamped = parseIntakeAnswers({ notifications: { live_count: 99, stuck_fraction: 0, cadence: "hourly" } });
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

test("buildWizardPrefill sets only what the answers decide; models keep the wizard default", () => {
  assert.deepEqual(buildWizardPrefill({ ...emptyIntake(), goal: "g" }), { job_type: "run" });
  assert.deepEqual(
    buildWizardPrefill({ ...emptyIntake(), goal: " faster ", source: "repo", spending_limit_cents: 900 }),
    { job_type: "blackbox", blackbox_objective: "faster", max_cost_cents: 900 },
  );
});

test("agentBrief needs a goal and fills the template", () => {
  const template = (v: Record<string, string>) => `${v.goal}|${v.source}`;
  assert.equal(agentBrief(emptyIntake(), template), null);
  assert.equal(
    agentBrief({ ...emptyIntake(), goal: "g", source: "repo", source_url: "acme/r" }, template),
    "g|acme/r",
  );
});
