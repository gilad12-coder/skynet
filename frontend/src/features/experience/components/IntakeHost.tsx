"use client";

import * as React from "react";
import { AnimatePresence, motion, useReducedMotion, type Transition } from "framer-motion";
import { usePathname, useRouter } from "next/navigation";
import { Dialog as DialogPrimitive } from "radix-ui";

import {
  extractWizardPatch,
  queueAgentPrompt,
  useWizardStateOptional,
} from "@/features/agent-panel";
import { useUserPrefs } from "@/features/settings";
import {
  updateModelPrivacy,
  updateNotificationPreferences,
  type InterviewOption,
} from "@/shared/lib/api";
import { formatMsg, msg, type MessageKey } from "@/shared/lib/messages";
import {
  FULL_TRANSLATION_LOCALES,
  LOCALE_REGISTRY,
  isLocale,
  type Locale,
} from "@/shared/lib/locale";
import { getActiveDir, getActiveIntlLocale } from "@/shared/lib/runtime-locale";
import { useLocale } from "@/shared/providers";
import { cn } from "@/shared/lib/utils";
import { QuestionChoices } from "@/shared/ui/agent";
import { CaretLeft, CaretRight, CircleNotch } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import { Input } from "@/shared/ui/primitives/input";
import { TOUCH_FIELD } from "@/shared/ui/touch";
import type { ModelDataPolicy } from "@/shared/types/api";

import {
  BUDGET_PRESETS_USD,
  INTAKE_PHASES,
  SKIP_PATCH,
  agentBrief,
  applyInterviewTurn,
  buildExperiencePatch,
  buildNotificationPatch,
  buildWizardPrefill,
  classifySourceText,
  clearIntakeDraft,
  effectiveLevel,
  emptyDraft,
  isLlmPhase,
  languageChoices,
  markAnswered,
  nextPhase,
  prepareLanguageSwitch,
  previousScreen,
  profileSoFar,
  readIntakeDraft,
  recipeFor,
  resumeAfterLanguageSwitch,
  takeIntakeResume,
  writeIntakeDraft,
  type IntakeAnswers,
  type IntakeDraft,
  type IntakePhase,
  type IntakeSourceKind,
  type IntakeTrustMode,
} from "../lib/intake";
import { useExperienceOptional } from "../providers/experience-provider";
import { IntakeInterview } from "./IntakeInterview";
import { TOUCH_TAP } from "./touch";

const PHASE_LABELS: Record<IntakePhase, MessageKey> = {
  language: "experience.intake.phase.language",
  goal: "experience.intake.phase.goal",
  source: "experience.intake.phase.source",
  billing: "experience.intake.phase.billing",
  budget: "experience.intake.phase.budget",
  privacy: "experience.intake.phase.privacy",
  emails: "experience.intake.phase.emails",
  trust: "experience.intake.phase.trust",
};

const GOAL_OPTIONS = [
  ["experience.intake.q1.option.classify", "experience.intake.q1.option.classify_description"],
  ["experience.intake.q1.option.extract", "experience.intake.q1.option.extract_description"],
  ["experience.intake.q1.option.agent", "experience.intake.q1.option.agent_description"],
  ["experience.intake.q1.option.code", "experience.intake.q1.option.code_description"],
] as const satisfies ReadonlyArray<readonly [MessageKey, MessageKey]>;

const SOURCE_OPTIONS = [
  {
    source: "spreadsheet",
    label: "experience.intake.q2.option.spreadsheet",
    description: "experience.intake.q2.option.spreadsheet_description",
  },
  {
    source: "file",
    label: "experience.intake.q2.option.file",
    description: "experience.intake.q2.option.file_description",
  },
  {
    source: "dataset",
    label: "experience.intake.q2.option.dataset",
    description: "experience.intake.q2.option.dataset_description",
  },
  {
    source: "none",
    label: "experience.intake.q2.option.none",
    description: "experience.intake.q2.option.none_description",
  },
] as const satisfies ReadonlyArray<{
  source: IntakeSourceKind;
  label: MessageKey;
  description: MessageKey;
}>;

const PRIVACY_OPTIONS: ReadonlyArray<{
  value: ModelDataPolicy;
  label: MessageKey;
  description: MessageKey;
}> = [
  {
    value: "allow",
    label: "settings.model_privacy.allow.label",
    description: "settings.model_privacy.allow.description",
  },
  {
    value: "deny",
    label: "settings.model_privacy.deny.label",
    description: "settings.model_privacy.deny.description",
  },
  {
    value: "zdr",
    label: "settings.model_privacy.zdr.label",
    description: "settings.model_privacy.zdr.description",
  },
];

const CADENCE_OPTIONS = [
  ["done", "experience.notify.cadence.done", "experience.notify.cadence.done_tip"],
  [
    "milestones",
    "experience.notify.cadence.milestones",
    "experience.notify.cadence.milestones_tip",
  ],
  ["live", "experience.notify.cadence.live", "experience.notify.cadence.live_tip"],
] as const satisfies ReadonlyArray<readonly [string, MessageKey, MessageKey]>;

const TRUST_OPTIONS: ReadonlyArray<{
  value: IntakeTrustMode;
  label: MessageKey;
  description: MessageKey;
}> = [
  {
    value: "ask",
    label: "auto.features.agent.panel.hooks.use.trust.mode.literal.1",
    description: "auto.features.agent.panel.hooks.use.trust.mode.literal.4",
  },
  {
    value: "auto_safe",
    label: "auto.features.agent.panel.hooks.use.trust.mode.literal.2",
    description: "auto.features.agent.panel.hooks.use.trust.mode.literal.5",
  },
  {
    value: "yolo",
    label: "auto.features.agent.panel.hooks.use.trust.mode.literal.3",
    description: "auto.features.agent.panel.hooks.use.trust.mode.literal.6",
  },
];

const BUDGET_DESCRIPTIONS: Record<number, MessageKey> = {
  20: "experience.intake.budget.preset_20",
  5: "experience.intake.budget.preset_5",
  50: "experience.intake.budget.preset_50",
};

/*
 * The entrance: on a first login the app shows as normal for a moment, so the
 * user sees what they are setting up, then dissolves into the setup's title,
 * which holds long enough to read before the questions take its place.
 */
const APP_GLANCE_MS = 2000;
const TITLE_HOLD_MS = 1500;
const ENTER_MS = 900;
const REDUCED_ENTER_MS = 200;

const EASE_OUT: Transition["ease"] = [0.16, 1, 0.3, 1];

type Stage = "glance" | "title" | "questions";

/*
 * The entrance and the language question always read in English, whatever
 * language the browser or a past visit left active: the user has not chosen
 * one yet. Only the active locale's catalog reaches the browser, so the few
 * strings these screens need are kept here rather than in a locale file.
 */
const ENGLISH_ENTRY: Partial<Record<MessageKey, string>> = {
  "experience.intake.entrance.title": "New to Skynet? Let's get you set up.",
  "experience.intake.language.title": "Which language should Skynet speak?",
  "experience.intake.language.hint":
    "The app and the assistant both switch to it. You can change it any time in Settings.",
  "experience.intake.phase.language": "Language",
  "experience.intake.step": "Question {n} of {total}",
  "experience.intake.skip": "Skip setup",
  "experience.intake.next": "Continue",
};

function englishEntry(key: MessageKey, params?: Record<string, string | number>): string {
  const template = ENGLISH_ENTRY[key];
  if (!template) return msg(key, params);
  return Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    template,
  );
}

function usd(amount: number): string {
  return new Intl.NumberFormat(getActiveIntlLocale(), {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(amount);
}

/** The agenda as a bar, the current question named under it. */
function IntakeProgress({ index, total, label }: { index: number; total: number; label: string }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-1" aria-hidden>
        {Array.from({ length: total }, (_, i) => (
          <span
            key={i}
            className={cn(
              "h-1 flex-1 rounded-full transition-colors duration-300 ease-out",
              i <= index ? "bg-foreground" : "bg-border",
            )}
          />
        ))}
      </div>
      <p className="min-h-4 text-xs text-muted-foreground" aria-live="polite">
        {label}
      </p>
    </div>
  );
}

/** The question carries the screen; the hint sits tight beneath it. */
function QuestionHeading({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h2 className="text-xl font-semibold leading-snug tracking-tight text-balance sm:text-2xl">
        {title}
      </h2>
      {hint && <p className="text-sm leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** The interview's answer cards, set in the question screen instead of under a chat. */
function Choices(props: React.ComponentProps<typeof QuestionChoices>) {
  return <QuestionChoices {...props} className="border-t-0 px-0 pt-0" />;
}

/**
 * The first-login setup: the language first, then a short interview a
 * language model runs (what to improve, where it lives, billing, budget,
 * privacy, emails, the assistant's freedom), then one closing line and the
 * wizard opens filled in. Model choice and the wizard defaults keep the app's
 * defaults. When the interviewer is unavailable each phase turns into a fixed
 * question. A full-screen surface over the app, shown to every account whose
 * setup is not done, before the tour; Settings can rerun it.
 */
export function IntakeHost({ agentEnabled }: { agentEnabled: boolean }) {
  const experience = useExperienceOptional();
  const open = !!experience?.intakeOpen;
  const pathname = usePathname();
  // The setup never covers the sign-in or public pages.
  const bare =
    pathname === "/login" ||
    pathname === "/terms" ||
    pathname === "/privacy" ||
    pathname.startsWith("/share/");
  return (
    <AnimatePresence>
      {experience && open && !bare && <IntakeSurface key="intake" agentEnabled={agentEnabled} />}
    </AnimatePresence>
  );
}

function IntakeSurface({ agentEnabled }: { agentEnabled: boolean }) {
  const experience = useExperienceOptional()!;
  const wizard = useWizardStateOptional();
  const { setPref } = useUserPrefs();
  const router = useRouter();
  const { locale, setLocale } = useLocale();
  const reduceMotion = useReducedMotion() ?? false;

  const [initial] = React.useState(() => {
    // Back from the reload a language switch makes: carry on at the next question.
    const resume = takeIntakeResume();
    const stored = readIntakeDraft();
    const restored = resume
      ? resumeAfterLanguageSwitch(stored, resume, locale)
      : (stored ?? emptyDraft());
    // Nothing is asked before the language, even from a draft an older setup left.
    const draft: IntakeDraft = restored.answered.includes("language")
      ? restored
      : { ...restored, screen: "language" };
    // A setup already under way picks up where it was, without the entrance again.
    const underway = draft.answered.includes("language");
    const stage: Stage = underway ? "questions" : experience.rerunning ? "title" : "glance";
    return { draft, stage };
  });
  const [draft, setDraft] = React.useState<IntakeDraft>(initial.draft);
  const [stage, setStage] = React.useState<Stage>(initial.stage);
  const [fallbackNote, setFallbackNote] = React.useState(false);
  const [finishing, setFinishing] = React.useState(false);

  const { answers, screen, answered } = draft;
  const fixed = draft.fixed || !agentEnabled;
  const [sourceText, setSourceText] = React.useState(() => answers.source_url);

  React.useEffect(() => {
    writeIntakeDraft(draft);
  }, [draft]);

  React.useEffect(() => {
    if (stage === "questions") return;
    const delay =
      stage === "glance"
        ? APP_GLANCE_MS
        : (reduceMotion ? REDUCED_ENTER_MS : ENTER_MS) + TITLE_HOLD_MS;
    const timer = setTimeout(() => setStage(stage === "glance" ? "title" : "questions"), delay);
    return () => clearTimeout(timer);
  }, [stage, reduceMotion]);

  const update = (patch: Partial<IntakeAnswers>) =>
    setDraft((prev) => ({ ...prev, answers: { ...prev.answers, ...patch } }));

  const goTo = (next: IntakeDraft["screen"]) => {
    setFallbackNote(false);
    setDraft((prev) => ({ ...prev, screen: next }));
  };

  /** Record a fixed question's answer and move to the next open one. */
  const answer = (phase: IntakePhase, patch: Partial<IntakeAnswers> = {}) => {
    setFallbackNote(false);
    setDraft((prev) => {
      const nextAnswered = markAnswered(prev.answered, [phase]);
      return {
        ...prev,
        answers: { ...prev.answers, ...patch },
        answered: nextAnswered,
        screen: nextPhase(nextAnswered, phase) ?? "done",
      };
    });
  };

  const fallBack = () => {
    setFallbackNote(true);
    setDraft((prev) => {
      // What the user already typed to the interviewer stays their answer.
      const said = prev.turns.goal.find((t) => t.role === "user")?.content.trim() ?? "";
      const nextAnswers =
        !prev.answers.goal.trim() && said ? { ...prev.answers, goal: said } : prev.answers;
      return { ...prev, answers: nextAnswers, fixed: true };
    });
  };

  const detected = classifySourceText(sourceText);

  const setSourceFromText = (text: string) => {
    setSourceText(text);
    const hit = classifySourceText(text);
    if (hit) {
      update({ source: hit.kind, source_url: hit.value });
    } else if (answers.source === "repo" || answers.source === "api") {
      update({ source: null, source_url: "" });
    }
  };

  const finish = async () => {
    setFinishing(true);
    const final: IntakeAnswers = {
      ...answers,
      level: effectiveLevel(answers),
      byok_provider: answers.billing === "byok" ? answers.byok_provider : null,
    };
    // Only answers the user gave are written; an untouched setting keeps its value.
    if (final.trust) setPref("agentTrustMode", final.trust);
    if (final.privacy) {
      await updateModelPrivacy({ data_policy: final.privacy }).catch(() => undefined);
    }
    // Notifications before the experience PATCH, which closes the setup.
    await updateNotificationPreferences(buildNotificationPatch(final.notifications)).catch(
      () => undefined,
    );
    await experience.save(buildExperiencePatch(final));
    wizard?.applyAgentPatch(extractWizardPatch(buildWizardPrefill(final)));
    if (agentEnabled) {
      const brief = agentBrief(final, (values) =>
        formatMsg("experience.intake.agent_brief", values),
      );
      if (brief) queueAgentPrompt(brief);
    }
    clearIntakeDraft();
    experience.closeIntake();
    router.push(`/submit?recipe=${recipeFor(final.source)}`);
  };

  const skip = () => {
    clearIntakeDraft();
    // A rerun that is dismissed keeps the level the user already had.
    void experience.save(experience.rerunning ? { intake_completed: true } : SKIP_PATCH);
    experience.closeIntake();
  };

  const done = screen === "done";
  const interviewing = !done && isLlmPhase(screen) && !fixed && !answered.includes(screen);
  const back = previousScreen(screen);
  const total = INTAKE_PHASES.length;
  const progressIndex = done ? total : INTAKE_PHASES.indexOf(screen);
  // Until a language is chosen the setup speaks English; see ENGLISH_ENTRY.
  const inEnglish = stage !== "questions" || screen === "language";
  const t = inEnglish ? englishEntry : msg;
  const progressLabel = done
    ? ""
    : `${t(PHASE_LABELS[screen])} · ${t("experience.intake.step", {
        n: progressIndex + 1,
        total,
      })}`;

  const canContinue =
    screen === "goal"
      ? answers.goal.trim().length > 0
      : screen === "source"
        ? answers.source !== null
        : true;

  const keepCurrent: InterviewOption = {
    label: msg("experience.intake.chat.keep_current"),
    description: msg("experience.intake.chat.keep_current_description"),
  };

  const chooseLanguage = (next: string) => {
    if (next === locale || !isLocale(next)) {
      answer("language", { language: locale });
      return;
    }
    // The switch reloads the page; the draft and its note bring the user back here.
    setDraft(prepareLanguageSwitch(draft, next));
    setLocale(next);
  };

  const renderQuestion = (phase: IntakePhase) => {
    switch (phase) {
      case "language": {
        const choices = languageChoices<Locale>("en", FULL_TRANSLATION_LOCALES);
        const options: InterviewOption[] = choices.map((l) => ({
          label: LOCALE_REGISTRY[l].nativeName,
          description: LOCALE_REGISTRY[l].englishName,
        }));
        const picked = isLocale(answers.language) ? answers.language : "en";
        return (
          <section className="flex flex-col gap-6">
            <QuestionHeading
              title={t("experience.intake.language.title")}
              hint={t("experience.intake.language.hint")}
            />
            <Choices
              options={options}
              selected={options[Math.max(0, choices.indexOf(picked))]!.label}
              ariaLabel={t("experience.intake.language.title")}
              onSelect={(_, index) => chooseLanguage(choices[index] ?? locale)}
            />
          </section>
        );
      }
      case "goal": {
        const options = GOAL_OPTIONS.map(([label, description]) => ({
          label: msg(label),
          description: msg(description),
        }));
        return (
          <section className="flex flex-col gap-6">
            <QuestionHeading
              title={msg("experience.intake.q1.title")}
              hint={msg("experience.intake.q1.hint")}
            />
            <div className="flex flex-col gap-3">
              <Input
                autoFocus
                value={answers.goal}
                placeholder={msg("experience.intake.q1.placeholder")}
                aria-label={msg("experience.intake.q1.title")}
                onChange={(e) => update({ goal: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canContinue) answer("goal");
                }}
                className={cn(TOUCH_FIELD, "text-sm")}
              />
              <Choices
                options={options}
                selected={answers.goal}
                ariaLabel={msg("experience.intake.q1.title")}
                onSelect={(goal) => answer("goal", { goal, success_signal: "" })}
              />
            </div>
          </section>
        );
      }
      case "source": {
        const options = SOURCE_OPTIONS.map((o) => ({
          label: msg(o.label),
          description: msg(o.description),
        }));
        const current = SOURCE_OPTIONS.find((o) => o.source === answers.source);
        return (
          <section className="flex flex-col gap-6">
            <QuestionHeading
              title={msg("experience.intake.q2.title")}
              hint={msg("experience.intake.q2.hint")}
            />
            <div className="flex flex-col gap-3">
              <Input
                autoFocus
                dir="ltr"
                inputMode="url"
                value={sourceText}
                placeholder={msg("experience.intake.q2.placeholder")}
                aria-label={msg("experience.intake.q2.title")}
                onChange={(e) => setSourceFromText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canContinue) answer("source");
                }}
                className={cn(TOUCH_FIELD, "text-sm")}
              />
              {sourceText.trim() && (
                <p className="text-xs text-muted-foreground" role="status">
                  {detected?.kind === "repo"
                    ? formatMsg("experience.intake.q2.detected_repo", { name: detected.value })
                    : detected?.kind === "api"
                      ? msg("experience.intake.q2.detected_api")
                      : msg("experience.intake.q2.unrecognized")}
                </p>
              )}
              <Choices
                options={options}
                selected={current ? msg(current.label) : []}
                ariaLabel={msg("experience.intake.q2.title")}
                onSelect={(_, index) => {
                  setSourceText("");
                  answer("source", {
                    source: SOURCE_OPTIONS[index]!.source,
                    source_url: "",
                  });
                }}
              />
            </div>
          </section>
        );
      }
      case "billing": {
        const options = [
          {
            label: msg("experience.intake.q3.billing.platform"),
            description: msg("experience.intake.billing.platform_description"),
          },
          {
            label: msg("experience.intake.q3.billing.byok"),
            description: msg("experience.intake.billing.byok_description"),
          },
        ];
        return (
          <section className="flex flex-col gap-6">
            <QuestionHeading
              title={msg("experience.intake.billing.title")}
              hint={msg("experience.intake.billing.hint")}
            />
            <Choices
              options={options}
              selected={options[answers.billing === "byok" ? 1 : 0]!.label}
              ariaLabel={msg("experience.intake.billing.title")}
              onSelect={(_, index) =>
                answer(
                  "billing",
                  index === 1 ? { billing: "byok" } : { billing: "platform", byok_provider: null },
                )
              }
            />
          </section>
        );
      }
      case "budget": {
        const suggest: InterviewOption = {
          label: msg("experience.intake.budget.suggest"),
          description: msg("experience.intake.budget.suggest_description"),
        };
        const options: InterviewOption[] = [
          ...BUDGET_PRESETS_USD.map((amount) => ({
            label: usd(amount),
            description: msg(BUDGET_DESCRIPTIONS[amount]!),
          })),
          suggest,
        ];
        const limit = answers.spending_limit_cents;
        return (
          <section className="flex flex-col gap-6">
            <QuestionHeading
              title={msg("experience.intake.budget.title")}
              hint={msg("experience.intake.budget.hint")}
            />
            <Choices
              options={options}
              selected={
                limit === null
                  ? suggest.label
                  : BUDGET_PRESETS_USD.includes(limit / 100)
                    ? usd(limit / 100)
                    : []
              }
              ariaLabel={msg("experience.intake.budget.title")}
              onSelect={(_, index) => {
                const amount = BUDGET_PRESETS_USD[index];
                answer("budget", {
                  spending_limit_cents: amount === undefined ? null : amount * 100,
                });
              }}
            />
          </section>
        );
      }
      case "privacy": {
        const options: InterviewOption[] = [
          ...PRIVACY_OPTIONS.map((o) => ({ label: msg(o.label), description: msg(o.description) })),
          keepCurrent,
        ];
        const current = PRIVACY_OPTIONS.find((o) => o.value === answers.privacy);
        return (
          <section className="flex flex-col gap-6">
            <QuestionHeading
              title={msg("experience.intake.privacy.title")}
              hint={msg("experience.intake.privacy.hint")}
            />
            <Choices
              options={options}
              selected={current ? msg(current.label) : keepCurrent.label}
              ariaLabel={msg("experience.intake.privacy.title")}
              onSelect={(_, index) =>
                answer("privacy", { privacy: PRIVACY_OPTIONS[index]?.value ?? null })
              }
            />
          </section>
        );
      }
      case "emails": {
        const options = CADENCE_OPTIONS.map(([, label, tip]) => ({
          label: msg(label),
          description: msg(tip),
        }));
        const current = CADENCE_OPTIONS.find(([value]) => value === answers.notifications.cadence);
        return (
          <section className="flex flex-col gap-6">
            <QuestionHeading
              title={msg("experience.intake.emails.title")}
              hint={msg("experience.intake.emails.hint")}
            />
            <Choices
              options={options}
              selected={current ? msg(current[1]) : []}
              ariaLabel={msg("experience.intake.emails.title")}
              onSelect={(_, index) =>
                answer("emails", {
                  notifications: { ...answers.notifications, cadence: CADENCE_OPTIONS[index]![0] },
                })
              }
            />
          </section>
        );
      }
      case "trust": {
        const options: InterviewOption[] = [
          ...TRUST_OPTIONS.map((o) => ({ label: msg(o.label), description: msg(o.description) })),
          keepCurrent,
        ];
        const current = TRUST_OPTIONS.find((o) => o.value === answers.trust);
        return (
          <section className="flex flex-col gap-6">
            <QuestionHeading
              title={msg("experience.intake.trust.title")}
              hint={msg("experience.intake.trust.hint")}
            />
            <Choices
              options={options}
              selected={current ? msg(current.label) : keepCurrent.label}
              ariaLabel={msg("experience.intake.trust.title")}
              onSelect={(_, index) =>
                answer("trust", { trust: TRUST_OPTIONS[index]?.value ?? null })
              }
            />
          </section>
        );
      }
    }
  };

  const ease: Transition = reduceMotion
    ? { duration: REDUCED_ENTER_MS / 1000, ease: "easeOut" }
    : { duration: ENTER_MS / 1000, ease: EASE_OUT };
  // A gentle rise only when motion is welcome; a plain fade otherwise.
  const rise = (y: number, scale = 1) => (reduceMotion ? { opacity: 0 } : { opacity: 0, y, scale });

  // Back and forward travel as one tight pair right under the answer, shaped
  // like the wizard's own step buttons.
  const rtl = !inEnglish && getActiveDir() === "rtl";
  const BackChevron = rtl ? CaretRight : CaretLeft;
  const NextChevron = rtl ? CaretLeft : CaretRight;
  const navButton = "min-h-[44px] lg:min-h-0 min-w-0 flex-1 gap-2 sm:flex-none";
  const actions = (
    <div className="flex items-stretch gap-2">
      {back && (
        <Button
          variant="outline"
          className={navButton}
          onClick={() => goTo(back)}
          disabled={finishing}
        >
          <BackChevron className="size-4" aria-hidden />
          {msg("experience.intake.back")}
        </Button>
      )}
      {done ? (
        <Button
          className={cn(navButton, "sm:min-w-[88px]")}
          onClick={() => void finish()}
          disabled={finishing}
          aria-busy={finishing || undefined}
        >
          {finishing ? (
            <>
              <CircleNotch className="animate-spin motion-reduce:animate-none" aria-hidden />
              {msg("experience.intake.finishing")}
            </>
          ) : (
            <>
              {msg("experience.intake.finish")}
              <NextChevron className="size-4" aria-hidden />
            </>
          )}
        </Button>
      ) : (
        !interviewing && (
          <Button
            className={cn(navButton, "sm:min-w-[88px]")}
            onClick={() =>
              screen === "language"
                ? chooseLanguage(isLocale(answers.language) ? answers.language : "en")
                : answer(screen)
            }
            disabled={!canContinue}
          >
            {t("experience.intake.next")}
            <NextChevron className="size-4" aria-hidden />
          </Button>
        )
      )}
    </div>
  );

  if (stage === "glance") return null;

  return (
    <DialogPrimitive.Root open modal>
      <DialogPrimitive.Portal forceMount>
        <DialogPrimitive.Content
          asChild
          forceMount
          aria-describedby={undefined}
          // Leaving is the Skip button only; a stray Escape never drops the answers.
          onEscapeKeyDown={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
        >
          <motion.div
            className="fixed inset-0 isolate flex flex-col overflow-hidden text-foreground outline-none"
            dir={inEnglish ? "ltr" : undefined}
            lang={inEnglish ? "en" : undefined}
            style={{ zIndex: 50 }}
            initial="hidden"
            animate="shown"
            exit="hidden"
          >
            {/*
             * Two layers dissolve the app: a frosted veil first, so the page
             * blurs away, then the setup's own opaque ground over it.
             */}
            <motion.div
              aria-hidden
              className="absolute inset-0 -z-10 bg-background/60 backdrop-blur-xl"
              variants={{ hidden: { opacity: 0 }, shown: { opacity: 1 } }}
              transition={reduceMotion ? ease : { ...ease, duration: (ENTER_MS * 0.6) / 1000 }}
            />
            <motion.div
              aria-hidden
              className="absolute inset-0 -z-10 bg-background"
              variants={{ hidden: { opacity: 0 }, shown: { opacity: 1 } }}
              transition={reduceMotion ? ease : { ...ease, delay: (ENTER_MS * 0.35) / 1000 }}
            />

            <DialogPrimitive.Title className="sr-only">
              {t("experience.intake.entrance.title")}
            </DialogPrimitive.Title>

            <AnimatePresence mode="wait" initial={false}>
              {stage === "title" ? (
                <motion.div
                  key="title"
                  className="flex flex-1 items-center justify-center px-6 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
                  initial={rise(16, 0.98)}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -24, scale: 0.96 }}
                  transition={reduceMotion ? ease : { ...ease, delay: (ENTER_MS * 0.45) / 1000 }}
                >
                  <p
                    aria-hidden
                    className="max-w-[18ch] text-center text-4xl font-semibold leading-tight tracking-tight text-balance sm:text-5xl"
                  >
                    {t("experience.intake.entrance.title")}
                  </p>
                </motion.div>
              ) : (
                <motion.div
                  key="questions"
                  className="flex min-h-0 flex-1 flex-col"
                  initial={rise(12)}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={ease}
                >
                  {/*
                   * Leaving lives up with the progress, away from the answer and
                   * Continue, so it is never hit while moving forward.
                   */}
                  <div className="mx-auto flex w-full max-w-2xl items-center gap-4 px-5 pt-[max(1.25rem,env(safe-area-inset-top))] sm:px-7 sm:pt-10">
                    <div className="min-w-0 flex-1">
                      <IntakeProgress index={progressIndex} total={total} label={progressLabel} />
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className={cn(TOUCH_TAP, "-me-3 text-muted-foreground hover:text-foreground")}
                      onClick={skip}
                      disabled={finishing}
                    >
                      {t("experience.intake.skip")}
                    </Button>
                  </div>

                  {interviewing ? (
                    <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col">
                      <div className="px-5 pt-6 sm:px-7">
                        <QuestionHeading
                          title={msg("experience.intake.chat.title")}
                          hint={msg("experience.intake.chat.description")}
                        />
                      </div>
                      <IntakeInterview
                        key={screen}
                        phase={screen}
                        turns={draft.turns[screen]}
                        options={draft.options[screen]}
                        profile={profileSoFar(answers, answered)}
                        onTurn={(sent, outcome) =>
                          setDraft((prev) => applyInterviewTurn(prev, screen, sent, outcome))
                        }
                        onFail={fallBack}
                      />
                      {back && (
                        <div className="px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-7">
                          {actions}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                      <div
                        className={cn(
                          "mx-auto w-full max-w-2xl px-5 pt-8 pb-[max(2.5rem,env(safe-area-inset-bottom))] sm:px-7 sm:pt-12",
                          done && "flex min-h-full flex-col justify-center",
                        )}
                      >
                        {fallbackNote && (
                          <p className="pb-4 text-xs text-muted-foreground" role="status">
                            {msg("experience.intake.chat.error")}
                          </p>
                        )}
                        {done ? (
                          <motion.div
                            key="done"
                            initial={rise(8)}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            transition={ease}
                          >
                            <QuestionHeading title={msg("experience.intake.done.title")} />
                          </motion.div>
                        ) : (
                          renderQuestion(screen)
                        )}
                        <div className="pt-8">{actions}</div>
                      </div>
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
