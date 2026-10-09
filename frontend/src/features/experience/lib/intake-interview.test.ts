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
    source: "repo",
    billing: "byok",
    byok_provider: " OpenAI ",
    budget_usd: "$20",
    privacy: "no_training",
    email_cadence: "hourly",
    trust: "yolo",
    level: "wizard",
  });
  // The setup is settings only: anything about a first run is dropped.
  assert.equal("goal" in patch, false);
  assert.equal("source" in patch, false);
  assert.equal(patch.billing, "byok");
  assert.equal(patch.byok_provider, "openai");
  assert.equal(patch.spending_limit_cents, 2000);
  assert.equal(patch.privacy, "deny");
  assert.equal(patch.cadence, undefined);
  assert.equal(patch.trust, "yolo");
  assert.equal(patch.level, undefined);
  assert.deepEqual(phases, ["billing", "budget", "privacy", "trust"]);
});

test("coerceProfilePatch: a key without a provider leaves billing open; junk yields nothing", () => {
  assert.deepEqual(coerceProfilePatch({ billing: "byok" }).phases, []);
  assert.equal(coerceProfilePatch({ budget_usd: "suggest" }).patch.spending_limit_cents, null);
  assert.equal(coerceProfilePatch({ budget_usd: 99_999 }).patch.spending_limit_cents, 1_000_000);
  assert.deepEqual(coerceProfilePatch({ budget_usd: -5 }).phases, []);
  assert.deepEqual(coerceProfilePatch(null), { patch: {}, phases: [] });
  assert.deepEqual(coerceProfilePatch(["billing"]), { patch: {}, phases: [] });
  assert.deepEqual(coerceSkipPhases(["trust", "bogus", "language"]), ["language", "trust"]);
});

test("the agenda is settings only: the language, then the account settings", () => {
  assert.deepEqual(INTAKE_PHASES, ["language", "billing", "budget", "privacy", "emails", "trust"]);
  assert.equal(nextPhase([], null), "language");
  assert.equal(nextPhase(["language"], "language"), "billing");
  // Wraps back to an earlier open question before the closing line.
  assert.equal(nextPhase(markAnswered([], ["billing", "budget"]), "trust"), "language");
  assert.equal(nextPhase(INTAKE_PHASES, "trust"), null);
  assert.equal(previousScreen("language"), null);
  assert.equal(previousScreen("billing"), "language");
  assert.equal(previousScreen("done"), "trust");
});

test("profileSoFar only reports what the user answered, in the interviewer's words", () => {
  const answers = {
    ...emptyIntake(),
    language: "he" as const,
    billing: "byok" as const,
    privacy: "deny" as const,
    spending_limit_cents: null,
  };
  assert.deepEqual(profileSoFar(answers, []), {});
  assert.deepEqual(profileSoFar(answers, ["language", "privacy", "budget", "emails"]), {
    language: "he",
    budget_usd: "suggest",
    privacy: "no_training",
    email_cadence: "done",
  });
});

test("applyInterviewTurn keeps an open phase's transcript and options", () => {
  const sent = [{ role: "user" as const, content: "not sure" }];
  const draft = applyInterviewTurn(
    { ...emptyDraft(), screen: "billing" },
    "billing",
    sent,
    outcome({
      message: " Do you have your own key? ",
      options: [{ label: "Yes, OpenAI", description: "d" }],
      profile_patch: { trust: "ask" },
    }),
  );
  assert.equal(draft.screen, "billing");
  assert.deepEqual(draft.turns.billing, [
    ...sent,
    { role: "assistant", content: "Do you have your own key?" },
  ]);
  assert.deepEqual(draft.options.billing, [{ label: "Yes, OpenAI", description: "d" }]);
  // A volunteered later answer is kept and its phase skipped.
  assert.deepEqual(draft.answered, ["trust"]);
  assert.equal(draft.answers.trust, "ask");
});

test("applyInterviewTurn finishing a phase moves on, or to the closing line on skip_rest", () => {
  const base = {
    ...emptyDraft(),
    answered: markAnswered([], ["language"]),
    screen: "billing" as const,
  };
  const sent = [{ role: "user" as const, content: "use your credits" }];
  const done = applyInterviewTurn(
    base,
    "billing",
    sent,
    outcome({ phase_done: true, profile_patch: { billing: "platform" } }),
  );
  assert.equal(done.answers.billing, "platform");
  assert.deepEqual(done.answered, ["language", "billing"]);
  assert.equal(done.screen, "budget");
  assert.deepEqual(done.options.billing, []);
  const rest = applyInterviewTurn(
    base,
    "billing",
    sent,
    outcome({ phase_done: true, skip_rest: true }),
  );
  assert.equal(rest.screen, "done");
  // The last phase done leads to the closing line too.
  const last = applyInterviewTurn(
    { ...base, answered: markAnswered([], INTAKE_PHASES.slice(0, -1)), screen: "trust" },
    "trust",
    [{ role: "user", content: "ask me" }],
    outcome({ phase_done: true, profile_patch: { trust: "ask" } }),
  );
  assert.equal(last.screen, "done");
  assert.equal(last.answers.trust, "ask");
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
    ...emptyDraft({ ...emptyIntake(), billing: "byok" as const, language: "fr" as const }),
    screen: "done" as const,
    answered: markAnswered([], ["billing", "language"]),
    turns: { ...emptyDraft().turns, budget: [{ role: "user" as const, content: "g" }] },
    options: { ...emptyDraft().options, billing: [{ label: "A", description: "" }] },
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
      answered: ["goal", "budget", "nope"],
      turns: {
        budget: [
          { role: "system", content: "x" },
          { role: "user", content: "y" },
        ],
      },
      options: { budget: [{ label: " " }, { label: "B" }] },
    }),
  );
  assert.equal(odd?.screen, "language");
  // An older draft's goal / source answers are dropped with the questions.
  assert.deepEqual(odd?.answered, ["budget"]);
  assert.deepEqual(odd?.turns.budget, [{ role: "user", content: "y" }]);
  assert.deepEqual(odd?.options.budget, [{ label: "B", description: "" }]);
  assert.equal(parseDraft(JSON.stringify({ answers: {}, screen: "goal" }))?.screen, "language");
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
  const before = { ...emptyDraft(), answers: { ...emptyIntake(), privacy: "zdr" as const } };
  const prepared = prepareLanguageSwitch(before, "he");
  assert.equal(prepared.screen, "billing");
  assert.equal(prepared.answers.language, "he");

  // The reload: a fresh mount reads the note once, then the draft alone.
  const resume = takeIntakeResume();
  assert.deepEqual(resume, { resumePhase: "billing", profile: { language: "he" } });
  assert.equal(takeIntakeResume(), null);
  const reopened = resumeAfterLanguageSwitch(readIntakeDraft(), resume!, "he");
  assert.equal(reopened.screen, "billing");
  assert.equal(reopened.answers.language, "he");
  assert.equal(reopened.answers.privacy, "zdr");
  assert.ok(reopened.answered.includes("language"));
  // The language question is not asked again.
  assert.equal(nextPhase(reopened.answered, null), "billing");
});

test("a language change with everything answered comes back to the closing line", () => {
  const fromDone = {
    ...emptyDraft({ ...emptyIntake(), billing: "byok" }),
    answered: markAnswered([], INTAKE_PHASES.slice(1)),
  };
  prepareLanguageSwitch(fromDone, "ja");
  const resume = takeIntakeResume();
  assert.equal(resume?.resumePhase, "done");
  // An older build's stored "summary" resumes on the closing line.
  assert.equal(parseDraft(JSON.stringify({ answers: {}, screen: "summary" }))?.screen, "done");
  // Storage lost the draft: still resumes, with the active locale.
  const reopened = resumeAfterLanguageSwitch(null, { resumePhase: "billing", profile: {} }, "ja");
  assert.equal(reopened.answers.language, "ja");
  assert.equal(reopened.screen, "billing");
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
