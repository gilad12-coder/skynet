"use client";

import * as React from "react";
import { AnimatePresence, motion, useReducedMotion, type Transition } from "framer-motion";
import { usePathname, useRouter } from "next/navigation";
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
import { ArrowLeft, ArrowLineRight, ArrowRight } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/primitives/tooltip";
import { SubmitSplashOverlay, SUBMIT_SPLASH_HOLD_MS } from "@/shared/ui/submit-splash-overlay";
import type { ModelDataPolicy } from "@/shared/types/api";

import {
  INTAKE_PHASES,
  SKIP_PATCH,
  buildExperiencePatch,
  buildNotificationPatch,
  clearIntakeDraft,
  emptyDraft,
  languageChoices,
  markAnswered,
  nextPhase,
  prepareLanguageSwitch,
  previousScreen,
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
import { TOUCH_TAP_SQUARE } from "./touch";

const PHASE_LABELS: Record<IntakePhase, MessageKey> = {
  language: "experience.intake.phase.language",
  billing: "experience.intake.phase.billing",
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

/*
 * The English screens set Latin text in the app's English face (Geist) even
 * when the active locale's UI font leads with another script's face, whose
 * Latin glyphs would otherwise draw the title. Other scripts on these screens
 * (the language names) still fall through to the locale's font.
 */
const ENGLISH_FONT = '"Geist Variable", var(--font-ui)';

/** Short screens (a landscape laptop, a phone with its browser bars) get a tighter setup. */
const QUESTION_SECTION =
  "flex min-h-0 flex-col gap-4 sm:gap-6 [@media(max-height:700px)]:gap-3 [@media(min-height:860px)]:sm:gap-8";

function englishEntry(key: MessageKey, params?: Record<string, string | number>): string {
  const template = ENGLISH_ENTRY[key];
  if (!template) return msg(key, params);
  return Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    template,
  );
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
      <h2 className="text-xl font-semibold leading-snug tracking-tight text-balance sm:text-3xl [@media(max-height:700px)]:text-xl">
        {title}
      </h2>
      {hint && (
        <p className="text-sm leading-relaxed text-muted-foreground sm:text-base [@media(max-height:700px)]:text-sm">
          {hint}
        </p>
      )}
    </div>
  );
}

/**
 * The interview's answer cards, set in the question screen instead of under a
 * chat. They are laid out to fit the screen; should a very short one still run
 * out of room, only the cards scroll, never the page or the buttons under them.
 */
function Choices({ className, ...props }: React.ComponentProps<typeof QuestionChoices>) {
  return (
    <QuestionChoices
      {...props}
      // The 1px inset keeps the cards' focus ring clear of the scroll clip.
      className={cn(
        "-m-1 min-h-0 overflow-y-auto overscroll-contain border-t-0 p-1",
        // A short list reads as one column of roomy cards; taller screens give each more air.
        "[&>div]:grid-cols-1 [&>div]:gap-2.5 sm:[&_button]:px-4 sm:[&_button]:py-3.5",
        "[@media(min-height:860px)]:sm:[&_button]:py-4.5 [@media(min-height:860px)]:[&>div]:gap-3",
        "[@media(max-height:700px)]:[&_button]:py-2 [@media(max-height:700px)]:[&>div]:gap-1.5",
        className,
      )}
    />
  );
}

/**
 * The first-login setup, settings only: the language, billing, privacy,
 * emails and the assistant's freedom, each a fixed question; finishing saves
 * them and opens a new optimization. Nothing about a first run is asked, and
 * model choice and the wizard defaults keep the app's defaults. A full-screen
 * surface over the app, shown to every account whose setup is not done,
 * before the tour; Settings can rerun it.
 */
export function IntakeHost() {
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
      {experience && open && !bare && <IntakeSurface key="intake" />}
    </AnimatePresence>
  );
}

function IntakeSurface() {
  const experience = useExperienceOptional()!;
  const { setPref } = useUserPrefs();
  const { locale, setLocale } = useLocale();
  const reduceMotion = useReducedMotion() ?? false;
  const router = useRouter();

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
  const [finale, setFinale] = React.useState<Finale>("none");
  const finishStarted = React.useRef(false);

  const { answers, screen } = draft;

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
    setDraft((prev) => ({ ...prev, screen: next }));
  };

  /** Record a fixed question's answer and move to the next open one. */
  const answer = (phase: IntakePhase, patch: Partial<IntakeAnswers> = {}) => {
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
    // The splash still covers the screen, so it slides up onto a new optimization.
    router.push("/submit");
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
          <section className={QUESTION_SECTION}>
            <QuestionHeading
              title={t("experience.intake.language.title")}
              hint={t("experience.intake.language.hint")}
            />
            <Choices
              options={options}
              selected={options[Math.max(0, choices.indexOf(picked))]!.label}
              ariaLabel={t("experience.intake.language.title")}
              // Seventeen languages fit as a three-column grid (two on a
              // phone, where each card shows only the language's own name).
              className="[&>div]:grid-cols-2 [&>div]:gap-2 sm:[&>div]:grid-cols-3 sm:[&_button]:py-2.5 max-sm:[&_[dir=auto]+[dir=auto]]:hidden [@media(min-height:860px)]:sm:[&_button]:py-3 [@media(max-height:700px)]:[&_button]:py-1.5"
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
          <section className={QUESTION_SECTION}>
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
      case "privacy": {
        const options: InterviewOption[] = [
          ...PRIVACY_OPTIONS.map((o) => ({ label: msg(o.label), description: msg(o.description) })),
          keepCurrent,
        ];
        const current = PRIVACY_OPTIONS.find((o) => o.value === answers.privacy);
        return (
          <section className={QUESTION_SECTION}>
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
          <section className={QUESTION_SECTION}>
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
          <section className={QUESTION_SECTION}>
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

  // Back, then Skip, sit together at the start; Continue, the forward step,
  // has the far end to itself. Each is an icon named by its tooltip.
  const rtl = !inEnglish && getActiveDir() === "rtl";
  const BackArrow = rtl ? ArrowRight : ArrowLeft;
  const NextArrow = rtl ? ArrowLeft : ArrowRight;
  const navTip = (label: string, button: React.ReactElement) => (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent dir={inEnglish ? "ltr" : getActiveDir()}>{label}</TooltipContent>
    </Tooltip>
  );
  const actions = (
    <div className="flex shrink-0 items-center gap-2">
      {back &&
        navTip(
          msg("experience.intake.back"),
          <Button
            variant="outline"
            size="icon-lg"
            className={TOUCH_TAP_SQUARE}
            aria-label={msg("experience.intake.back")}
            onClick={() => goTo(back)}
          >
            <BackArrow className="size-4" aria-hidden />
          </Button>,
        )}
      {!done &&
        navTip(
          t("experience.intake.skip"),
          <Button
            variant="outline"
            size="icon-lg"
            className={cn(TOUCH_TAP_SQUARE, "text-muted-foreground hover:text-foreground")}
            aria-label={t("experience.intake.skip")}
            onClick={skip}
          >
            <ArrowLineRight className={cn("size-4", rtl && "-scale-x-100")} aria-hidden />
          </Button>,
        )}
      {!done &&
        navTip(
          t("experience.intake.next"),
          <Button
            size="icon-lg"
            className={cn(TOUCH_TAP_SQUARE, "ms-auto")}
            aria-label={t("experience.intake.next")}
            onClick={() =>
              screen === "language"
                ? chooseLanguage(isLocale(answers.language) ? answers.language : "en")
                : answer(screen)
            }
          >
            <NextArrow className="size-4" aria-hidden />
          </Button>,
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
            className="fixed inset-0 isolate flex h-dvh flex-col overflow-hidden text-foreground outline-none"
            dir={inEnglish ? "ltr" : undefined}
            lang={inEnglish ? "en" : undefined}
            style={{
              zIndex: 50,
              backgroundColor: SPLASH_GROUND,
              fontFamily: inEnglish ? ENGLISH_FONT : undefined,
            }}
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
                  className="flex min-h-0 flex-1 flex-col items-center justify-center gap-[clamp(1.5rem,6dvh,3rem)] px-6 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
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
                    className="max-w-[16ch] text-center text-[clamp(2.25rem,min(11vw,9dvh),4.5rem)] font-semibold leading-[1.05] tracking-tight text-balance"
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
                  <div className="mx-auto w-full max-w-2xl shrink-0 px-5 pt-[max(1rem,env(safe-area-inset-top))] sm:px-7 sm:pt-10 [@media(max-height:700px)]:sm:pt-5">
                    <IntakeProgress index={progressIndex} total={total} label={progressLabel} />
                  </div>

                  <AnimatePresence mode="wait" initial={false}>
                    {done ? null : (
                      <motion.div
                        key={`fixed-${screen}`}
                        className="flex min-h-0 flex-1 flex-col"
                        {...step}
                        transition={stepTransition}
                      >
                        <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col gap-6 px-5 pt-6 pb-[max(1rem,env(safe-area-inset-bottom))] sm:gap-8 sm:px-7 sm:pt-10 [@media(max-height:700px)]:gap-4 [@media(max-height:700px)]:sm:pt-5">
                          {/* The question and its buttons sit as one group in the optical
                              middle of the screen; safe centering keeps the top in view
                              when a short screen has no room to spare. */}
                          <div className="flex min-h-0 flex-1 flex-col gap-6 pb-[6dvh] [justify-content:safe_center] sm:gap-8 [@media(max-height:700px)]:gap-4 [@media(max-height:700px)]:pb-0">
                            {renderQuestion(screen)}
                            {actions}
                          </div>
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
