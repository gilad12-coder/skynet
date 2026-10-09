import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  INTAKE_PHASES,
  applyInterviewTurn,
  clearIntakeDraft,
  coerceProfilePatch,
  coerceSkipPhases,
  emptyDraft,
  emptyIntake,
  languageChoices,
  markAnswered,
  nextPhase,
  parseDraft,
  parseIntakeAnswers,
  prepareLanguageSwitch,
  previousScreen,
  profileSoFar,
  readIntakeDraft,
  requestTurns,
  resumeAfterLanguageSwitch,
  takeIntakeResume,
  visiblePhases,
  writeIntakeDraft,
  type IntakeTurnOutcome,
} from "./intake.ts";
import { FULL_TRANSLATION_LOCALES } from "../../../shared/lib/locale.ts";

/** A Map-backed stand-in for the browser's sessionStorage. */
function installStorage(): Map<string, string> {
  const store = new Map<string, string>();
  (globalThis as { sessionStorage?: unknown }).sessionStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };
  return store;
}

let store: Map<string, string>;
beforeEach(() => {
  store = installStorage();
});
afterEach(() => {
  delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
});

function outcome(partial: Partial<IntakeTurnOutcome>): IntakeTurnOutcome {
  return {
    message: "",
    options: [],
    phase_done: false,
    profile_patch: null,
    skip_phases: [],
    skip_rest: false,
    ...partial,
  };
}

test("coerceProfilePatch keeps valid answers and drops anything unknown or out of range", () => {
  const { patch, phases } = coerceProfilePatch({
    goal: "  route tickets  ",
    source: "nonsense",
    source_url: "https://github.com/acme/router",
    models: ["openai/gpt-4o", "", 3, "openai/gpt-4o"],
    billing: "byok",
    byok_provider: " OpenAI ",
    budget_usd: "$20",
    privacy: "no_training",
    email_cadence: "hourly",
    trust: "yolo",
    code_assist: "auto",
    level: "wizard",
  });
  assert.equal(patch.goal, "route tickets");
  // An unknown source falls back to what the pasted link says.
  assert.equal(patch.source, "repo");
  assert.equal(patch.source_url, "acme/router");
  assert.deepEqual(patch.models, ["openai/gpt-4o"]);
  assert.equal(patch.billing, "byok");
  assert.equal(patch.byok_provider, "openai");
  assert.equal(patch.spending_limit_cents, 2000);
  assert.equal(patch.privacy, "deny");
  assert.equal(patch.cadence, undefined);
  assert.equal(patch.trust, "yolo");
  assert.equal(patch.level, undefined);
  // Code assist alone does not answer the two-part defaults question.
  assert.deepEqual(phases, ["goal", "source", "models", "billing", "budget", "privacy", "trust"]);
});

test("coerceProfilePatch: a key without a provider leaves billing open; junk yields nothing", () => {
  assert.deepEqual(coerceProfilePatch({ billing: "byok" }).phases, []);
  assert.equal(coerceProfilePatch({ budget_usd: "suggest" }).patch.spending_limit_cents, null);
  assert.equal(coerceProfilePatch({ budget_usd: 99_999 }).patch.spending_limit_cents, 1_000_000);
  assert.deepEqual(coerceProfilePatch({ budget_usd: -5 }).phases, []);
  assert.deepEqual(coerceProfilePatch(null), { patch: {}, phases: [] });
  assert.deepEqual(coerceProfilePatch(["goal"]), { patch: {}, phases: [] });
  assert.deepEqual(coerceSkipPhases(["trust", "bogus", "language"]), ["language", "trust"]);
});

test("the agenda opens on the language and hides the wizard defaults from Guided", () => {
  assert.equal(INTAKE_PHASES[0], "language");
  const guided = { ...emptyIntake(), source: "spreadsheet" as const };
  assert.ok(!visiblePhases(guided).includes("defaults"));
  assert.ok(visiblePhases({ ...guided, source: "repo" }).includes("defaults"));
  assert.ok(visiblePhases(guided, ["defaults"]).includes("defaults"));
  assert.equal(nextPhase(guided, [], null), "language");
  assert.equal(nextPhase(guided, ["language"], "language"), "goal");
  // Wraps back to an earlier open question before the summary.
  assert.equal(nextPhase(guided, markAnswered([], ["goal", "source"]), "level"), "language");
  assert.equal(previousScreen(guided, [], "language"), null);
  assert.equal(previousScreen(guided, [], "goal"), "language");
});

test("profileSoFar only reports what the user answered, in the interviewer's words", () => {
  const answers = {
    ...emptyIntake(),
    language: "he" as const,
    goal: "g",
    privacy: "deny" as const,
    spending_limit_cents: null,
  };
  assert.deepEqual(profileSoFar(answers, []), { goal: "g" });
  assert.deepEqual(profileSoFar(answers, ["language", "privacy", "budget", "emails"]), {
    language: "he",
    goal: "g",
    privacy: "no_training",
    email_cadence: "done",
  });
});

test("applyInterviewTurn keeps an open phase's transcript and options", () => {
  const sent = [{ role: "user" as const, content: "sort tickets" }];
  const draft = applyInterviewTurn(
    { ...emptyDraft(), screen: "goal" },
    "goal",
    sent,
    outcome({
      message: " How will you know? ",
      options: [{ label: "Accuracy", description: "d" }],
      profile_patch: { trust: "ask" },
    }),
  );
  assert.equal(draft.screen, "goal");
  assert.deepEqual(draft.turns.goal, [
    ...sent,
    { role: "assistant", content: "How will you know?" },
  ]);
  assert.deepEqual(draft.options.goal, [{ label: "Accuracy", description: "d" }]);
  // A volunteered later answer is kept and its phase skipped.
  assert.deepEqual(draft.answered, ["trust"]);
  assert.equal(draft.answers.trust, "ask");
});

test("applyInterviewTurn finishing a phase moves on, or to the summary on skip_rest", () => {
  const base = {
    ...emptyDraft(),
    answered: markAnswered([], ["language"]),
    screen: "goal" as const,
  };
  const sent = [{ role: "user" as const, content: "make my agent pass more tests" }];
  const done = applyInterviewTurn(base, "goal", sent, outcome({ phase_done: true }));
  // No parsed goal: the user's own words become it.
  assert.equal(done.answers.goal, "make my agent pass more tests");
  assert.deepEqual(done.answered, ["language", "goal"]);
  assert.equal(done.screen, "source");
  assert.deepEqual(done.options.goal, []);
  const rest = applyInterviewTurn(
    base,
    "goal",
    sent,
    outcome({ phase_done: true, skip_rest: true }),
  );
  assert.equal(rest.screen, "summary");
});

test("requestTurns caps the transcript a request carries", () => {
  const turns = Array.from({ length: 12 }, (_, i) => ({
    role: (i % 2 ? "assistant" : "user") as "user" | "assistant",
    content: String(i),
  }));
  assert.equal(requestTurns(turns).length, 8);
  assert.equal(requestTurns(turns)[0]!.content, "4");
});

test("drafts round-trip through storage and survive junk", () => {
  const draft = {
    ...emptyDraft({ ...emptyIntake(), goal: "g", language: "fr" as const }),
    screen: "summary" as const,
    answered: markAnswered([], ["goal", "language"]),
    turns: { goal: [{ role: "user" as const, content: "g" }], source: [] },
    options: { goal: [{ label: "A", description: "" }], source: [] },
    fixed: true,
  };
  writeIntakeDraft(draft);
  assert.deepEqual(readIntakeDraft(), draft);
  clearIntakeDraft();
  assert.equal(readIntakeDraft(), null);
  assert.equal(parseDraft("{not json"), null);
  assert.equal(parseDraft(JSON.stringify([1])), null);
  const odd = parseDraft(
    JSON.stringify({
      answers: {},
      screen: "elsewhere",
      answered: ["goal", "nope"],
      turns: {
        goal: [
          { role: "system", content: "x" },
          { role: "user", content: "y" },
        ],
      },
      options: { goal: [{ label: " " }, { label: "B" }] },
    }),
  );
  assert.equal(odd?.screen, "language");
  assert.deepEqual(odd?.answered, ["goal"]);
  assert.deepEqual(odd?.turns.goal, [{ role: "user", content: "y" }]);
  assert.deepEqual(odd?.options.goal, [{ label: "B", description: "" }]);
  // Only a locale-shaped code is kept; the registry check happens where it is used.
  assert.equal(parseIntakeAnswers({ language: "Hebrew!" })?.language, null);
  assert.equal(parseIntakeAnswers({ language: 7 })?.language, null);
  assert.equal(parseIntakeAnswers({ language: "zh-Hans" })?.language, "zh-Hans");
});

test("languageChoices puts the active language first, once", () => {
  const choices = languageChoices("de", FULL_TRANSLATION_LOCALES);
  assert.equal(choices[0], "de");
  assert.equal(choices.filter((l) => l === "de").length, 1);
  assert.ok(choices.includes("he") && choices.includes("en"));
});

test("a language switch reloads straight into the next question in the new language", () => {
  const before = { ...emptyDraft(), answers: { ...emptyIntake(), goal: "kept" } };
  const prepared = prepareLanguageSwitch(before, "he");
  assert.equal(prepared.screen, "goal");
  assert.equal(prepared.answers.language, "he");

  // The reload: a fresh mount reads the note once, then the draft alone.
  const resume = takeIntakeResume();
  assert.deepEqual(resume, { resumePhase: "goal", profile: { language: "he", goal: "kept" } });
  assert.equal(takeIntakeResume(), null);
  const reopened = resumeAfterLanguageSwitch(readIntakeDraft(), resume!, "he");
  assert.equal(reopened.screen, "goal");
  assert.equal(reopened.answers.language, "he");
  assert.equal(reopened.answers.goal, "kept");
  assert.ok(reopened.answered.includes("language"));
  // The language question is not asked again.
  assert.equal(nextPhase(reopened.answers, reopened.answered, null), "goal");
});

test("a language change from the summary comes back to the summary", () => {
  const all = markAnswered([], ["goal", "source", "models", "billing", "budget", "privacy"]);
  const fromSummary = {
    ...emptyDraft({ ...emptyIntake(), source: "spreadsheet" }),
    answered: markAnswered(all, ["emails", "trust", "level"]),
  };
  prepareLanguageSwitch(fromSummary, "ja");
  const resume = takeIntakeResume();
  assert.equal(resume?.resumePhase, "summary");
  // Storage lost the draft: still resumes, with the active locale.
  const reopened = resumeAfterLanguageSwitch(null, { resumePhase: "goal", profile: {} }, "ja");
  assert.equal(reopened.answers.language, "ja");
  assert.equal(reopened.screen, "goal");
});

test("finishing or skipping clears the resume note", () => {
  prepareLanguageSwitch(emptyDraft(), "ar");
  assert.ok(store.has("skynet.intake.resume"));
  clearIntakeDraft();
  assert.equal(store.size, 0);
  assert.equal(takeIntakeResume(), null);
});

test("storage that throws never breaks the setup", () => {
  (globalThis as { sessionStorage?: unknown }).sessionStorage = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
  };
  assert.doesNotThrow(() => prepareLanguageSwitch(emptyDraft(), "fr"));
  assert.equal(takeIntakeResume(), null);
  assert.equal(readIntakeDraft(), null);
  assert.doesNotThrow(() => clearIntakeDraft());
});
