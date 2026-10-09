"use client";

import * as React from "react";
import { AnimatePresence, motion, useReducedMotion, type Transition } from "framer-motion";
import { usePathname } from "next/navigation";
import { Dialog as DialogPrimitive } from "radix-ui";

import { useUserPrefs } from "@/features/settings";
import {
  updateModelPrivacy,
  updateNotificationPreferences,
  type InterviewOption,
} from "@/shared/lib/api";
import { msg, type MessageKey } from "@/shared/lib/messages";
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
import { AnimatedWordmark } from "@/shared/ui/animated-wordmark";
import { ArrowLineRight, CaretLeft, CaretRight } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/primitives/tooltip";
import { SubmitSplashOverlay, SUBMIT_SPLASH_HOLD_MS } from "@/shared/ui/submit-splash-overlay";
import type { ModelDataPolicy } from "@/shared/types/api";

import {
  BUDGET_PRESETS_USD,
  INTAKE_PHASES,
  SKIP_PATCH,
  applyInterviewTurn,
  buildExperiencePatch,
  buildNotificationPatch,
  clearIntakeDraft,
  emptyDraft,
  isLlmPhase,
  languageChoices,
  markAnswered,
  nextPhase,
  prepareLanguageSwitch,
  previousScreen,
  profileSoFar,
  readIntakeDraft,
  resumeAfterLanguageSwitch,
  takeIntakeResume,
  writeIntakeDraft,
  type IntakeAnswers,
  type IntakeDraft,
  type IntakePhase,
  type IntakeTrustMode,
} from "../lib/intake";
import { useExperienceOptional } from "../providers/experience-provider";
import { IntakeInterview } from "./IntakeInterview";

const PHASE_LABELS: Record<IntakePhase, MessageKey> = {
  language: "experience.intake.phase.language",
  billing: "experience.intake.phase.billing",
  budget: "experience.intake.phase.budget",
  privacy: "experience.intake.phase.privacy",
  emails: "experience.intake.phase.emails",
  trust: "experience.intake.phase.trust",
};

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
 * The setup moves like the splash that plays when an optimization is sent
 * (`SubmitSplashOverlay`). On a first login the app shows as normal for a
 * moment, so the user sees what they are setting up; then the setup's warm
 * panel slides down over it with the wordmark scaling in, and the title
 * settles under the wordmark long enough to read before the first question
 * takes its place. The finale is that splash itself, and leaving is its
 * mirror: the panel slides back up off the app it has configured.
 */
const APP_GLANCE_MS = 2000;
const SPLASH_EASE: Transition["ease"] = [0.16, 1, 0.3, 1];
const SPLASH_GROUND = "#F0EBE4";
const PANEL_S = 0.5;
const WORDMARK_DELAY_S = 0.3;
const WORDMARK_S = 0.4;
/** The title follows the wordmark in; the entrance is fully in once it lands. */
const TITLE_DELAY_S = WORDMARK_DELAY_S + WORDMARK_S - 0.1;
const TITLE_IN_MS = (TITLE_DELAY_S + WORDMARK_S) * 1000;
const TITLE_HOLD_MS = 2000;
const STEP_S = 0.35;
const REDUCED_S = 0.2;

type Stage = "glance" | "title" | "questions";

/** Where the finale is: not yet, the splash over the setup, or sliding off the app. */
type Finale = "none" | "splash" | "out";

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
 * The first-login setup, settings only: the language first, then a short
 * interview a language model runs (billing, budget, privacy, emails, the
 * assistant's freedom); finishing saves them and leaves the user on the page
 * they were on. Nothing about a first run is asked, and model choice and the
 * wizard defaults keep the app's defaults. When the interviewer is unavailable each phase turns into a fixed
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
  const { setPref } = useUserPrefs();
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
  const [finale, setFinale] = React.useState<Finale>("none");
  const finishStarted = React.useRef(false);

  const { answers, screen, answered } = draft;
  const fixed = draft.fixed || !agentEnabled;

  React.useEffect(() => {
    writeIntakeDraft(draft);
  }, [draft]);

  React.useEffect(() => {
    if (stage === "questions") return;
    const delay =
      stage === "glance"
        ? APP_GLANCE_MS
        : (reduceMotion ? REDUCED_S * 1000 : TITLE_IN_MS) + TITLE_HOLD_MS;
    const timer = setTimeout(() => setStage(stage === "glance" ? "title" : "questions"), delay);
    return () => clearTimeout(timer);
  }, [stage, reduceMotion]);

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
    setDraft((prev) => ({ ...prev, fixed: true }));
  };

  const finish = async () => {
    const final: IntakeAnswers = {
      ...answers,
      // The level is never asked: the interviewer's read, else what the user already has.
      level: answers.level_chosen
        ? answers.level
        : experience.rerunning
          ? experience.level
          : "standard",
      byok_provider: answers.billing === "byok" ? answers.byok_provider : null,
    };
    // Only answers the user gave are written; an untouched setting keeps its value.
    if (final.trust) setPref("agentTrustMode", final.trust);
    setFinale("splash");
    const hold = new Promise((resolve) => setTimeout(resolve, SUBMIT_SPLASH_HOLD_MS));
    // Notifications before the experience PATCH, which closes the setup.
    await Promise.all([
      hold,
      final.privacy
        ? updateModelPrivacy({ data_policy: final.privacy }).catch(() => undefined)
        : undefined,
      updateNotificationPreferences(buildNotificationPatch(final.notifications)).catch(
        () => undefined,
      ),
    ]);
    // The level and answers land while the splash still covers the app, so the
    // page is configured before it shows; marking the setup complete is what
    // unmounts it (and the splash with it), so that waits for the slide out.
    await experience.save({ ...buildExperiencePatch(final), intake_completed: undefined });
    clearIntakeDraft();
    setFinale("out");
  };

  const closeAfterSlide = () => {
    void experience.save({ intake_completed: true });
    experience.closeIntake();
  };

  const skip = () => {
    clearIntakeDraft();
    // A rerun that is dismissed keeps the level the user already had.
    void experience.save(experience.rerunning ? { intake_completed: true } : SKIP_PATCH);
    experience.closeIntake();
  };

  const done = screen === "done";

  // The last answer starts the finale on its own; the ref keeps it to one run.
  React.useEffect(() => {
    if (!done || finishStarted.current) return;
    finishStarted.current = true;
    void finish();
  }, [done]);
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

  const fade: Transition = { duration: REDUCED_S, ease: "easeOut" };
  const splash = (delay = 0, duration = WORDMARK_S): Transition =>
    reduceMotion ? fade : { duration, delay, ease: SPLASH_EASE };
  // One step hands off to the next with a short rise; a plain fade when motion is unwelcome.
  const step = reduceMotion
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : {
        initial: { opacity: 0, y: 12 },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: 0, y: -12 },
      };
  const stepTransition = splash(0, STEP_S);

  // Back and forward travel as one tight pair right under the answer, shaped
  // like the wizard's own step buttons.
  const rtl = !inEnglish && getActiveDir() === "rtl";
  const BackChevron = rtl ? CaretRight : CaretLeft;
  const NextChevron = rtl ? CaretLeft : CaretRight;
  const navButton = "min-h-[44px] lg:min-h-0 min-w-0 flex-1 gap-2 sm:flex-none";
  const actions = (
    <div className="flex items-stretch gap-2">
      {back && (
        <Button variant="outline" className={navButton} onClick={() => goTo(back)}>
          <BackChevron className="size-4" aria-hidden />
          {msg("experience.intake.back")}
        </Button>
      )}
      {!interviewing && !done && (
        <Button
          className={cn(navButton, "sm:min-w-[88px]")}
          onClick={() =>
            screen === "language"
              ? chooseLanguage(isLocale(answers.language) ? answers.language : "en")
              : answer(screen)
          }
        >
          {t("experience.intake.next")}
          <NextChevron className="size-4" aria-hidden />
        </Button>
      )}
      {/* Pushed to the far end so it is never the button under a thumb heading forward. */}
      {!done && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              className="ms-auto size-11 shrink-0 text-muted-foreground hover:text-foreground lg:size-9"
              aria-label={t("experience.intake.skip")}
              onClick={skip}
            >
              <ArrowLineRight className={cn("size-4", rtl && "-scale-x-100")} aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent dir={inEnglish ? "ltr" : getActiveDir()}>
            {t("experience.intake.skip")}
          </TooltipContent>
        </Tooltip>
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
          {/* The splash's panel: down from the top on the way in, back up on the way out. */}
          <motion.div
            className="fixed inset-0 isolate flex flex-col overflow-hidden text-foreground outline-none"
            dir={inEnglish ? "ltr" : undefined}
            lang={inEnglish ? "en" : undefined}
            style={{ zIndex: 50, backgroundColor: SPLASH_GROUND }}
            initial={reduceMotion ? { opacity: 0 } : { y: "-100%" }}
            animate={
              finale === "none"
                ? reduceMotion
                  ? { opacity: 1 }
                  : { y: 0 }
                : // Once the finale splash covers it, the setup steps aside so the
                  // splash sliding up reveals the configured app, not the setup.
                  {
                    opacity: 0,
                    transition: { delay: reduceMotion ? REDUCED_S : PANEL_S, duration: 0 },
                  }
            }
            exit={reduceMotion ? { opacity: 0 } : { y: "-100%" }}
            transition={reduceMotion ? fade : { duration: PANEL_S, ease: SPLASH_EASE }}
          >
            <DialogPrimitive.Title className="sr-only">
              {t("experience.intake.entrance.title")}
            </DialogPrimitive.Title>

            <AnimatePresence mode="wait" initial={false}>
              {stage === "title" ? (
                <motion.div
                  key="title"
                  className="flex flex-1 flex-col items-center justify-center gap-10 px-6 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] sm:gap-12"
                  exit={step.exit}
                  transition={stepTransition}
                >
                  <motion.div
                    initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={splash(WORDMARK_DELAY_S)}
                  >
                    <AnimatedWordmark size={64} autoMorph={!reduceMotion} morphSpeed={120} />
                  </motion.div>
                  <motion.p
                    aria-hidden
                    className="max-w-[16ch] text-center text-5xl font-semibold leading-[1.05] tracking-tight text-balance sm:text-7xl"
                    initial={step.initial}
                    animate={step.animate}
                    transition={splash(TITLE_DELAY_S)}
                  >
                    {t("experience.intake.entrance.title")}
                  </motion.p>
                </motion.div>
              ) : (
                <motion.div
                  key="questions"
                  className="flex min-h-0 flex-1 flex-col bg-background"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={stepTransition}
                >
                  <div className="mx-auto w-full max-w-2xl px-5 pt-[max(1.25rem,env(safe-area-inset-top))] sm:px-7 sm:pt-10">
                    <IntakeProgress index={progressIndex} total={total} label={progressLabel} />
                  </div>

                  <AnimatePresence mode="wait" initial={false}>
                    {done ? null : interviewing ? (
                      <motion.div
                        key={`chat-${screen}`}
                        className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col"
                        {...step}
                        transition={stepTransition}
                      >
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
                        <div className="px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-7">
                          {actions}
                        </div>
                      </motion.div>
                    ) : (
                      <motion.div
                        key={`fixed-${screen}`}
                        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
                        {...step}
                        transition={stepTransition}
                      >
                        <div className="mx-auto w-full max-w-2xl px-5 pt-8 pb-[max(2.5rem,env(safe-area-inset-bottom))] sm:px-7 sm:pt-12">
                          {fallbackNote && (
                            <p className="pb-4 text-xs text-muted-foreground" role="status">
                              {msg("experience.intake.chat.error")}
                            </p>
                          )}
                          {renderQuestion(screen)}
                          <div className="pt-8">{actions}</div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
      {/* The finale is the splash an optimization gets when it is sent. */}
      <SubmitSplashOverlay show={finale === "splash"} slideOut onExited={closeAfterSlide} />
    </DialogPrimitive.Root>
  );
}
