"use client";

import * as React from "react";
import { AnimatePresence, motion, useReducedMotion, type Transition } from "framer-motion";
import { usePathname, useRouter } from "next/navigation";
import { Dialog as DialogPrimitive } from "radix-ui";

import { useSettingsModal, useUserPrefs } from "@/features/settings";
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
import { useLocale } from "@/shared/providers";
import { cn } from "@/shared/lib/utils";
import { QuestionChoices } from "@/shared/ui/agent";
import { AnimatedWordmark } from "@/shared/ui/animated-wordmark";
import { ArrowRight, Compass, FadersHorizontal, Wrench, X } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import { Segmented } from "@/shared/ui/segmented";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/primitives/tooltip";
import { SubmitSplashOverlay, SUBMIT_SPLASH_HOLD_MS } from "@/shared/ui/submit-splash-overlay";
import type { ModelDataPolicy } from "@/shared/types/api";

import { EXPERIENCE_LEVELS, type ExperienceLevel } from "../lib/abstraction";
import {
  buildExperiencePatch,
  buildNotificationPatch,
  clearIntakeDraft,
  emptyDraft,
  languageChoices,
  markAnswered,
  prepareLanguageSwitch,
  readIntakeDraft,
  resumeAfterLanguageSwitch,
  takeIntakeResume,
  writeIntakeDraft,
  type IntakeAnswers,
  type IntakeDraft,
  type IntakeLlmPhase,
  type IntakeTrustMode,
} from "../lib/intake";
import { SETUP_SETTING_EVENT, SETUP_STOPS, type SetupSettingDetail } from "../lib/setup-tour";
import { useExperienceOptional } from "../providers/experience-provider";
import { LEVEL_KEYS } from "./level-keys";
import { SetupTour } from "./SetupTour";
import { TOUCH_TAP_SQUARE } from "./touch";

const LEVEL_ICONS = { guided: Compass, standard: FadersHorizontal, expert: Wrench } as const;

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
 * settles under the wordmark long enough to read before the language
 * question takes its place. The panel then slides back up and the rest of
 * the setup walks the app itself; the finale is that splash.
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
/*
 * A picked answer stays marked this long before the tour moves on, so the
 * user sees it land (the level reshapes the dashboard behind the card). A
 * still hold, not motion, so it is the same under reduced motion.
 */
const ANSWER_HOLD_MS = 700;

type Stage = "glance" | "title" | "language" | "tour";

/** Where the finale is: not yet, the splash over the app, or sliding off it. */
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
  "experience.intake.skip": "Skip setup",
  "experience.intake.next": "Continue",
};

/*
 * The English screens set Latin text in the app's English face (Onest) even
 * when the active locale's UI font leads with another script's face, whose
 * Latin glyphs would otherwise draw the title. Other scripts on these screens
 * (the language names) still fall through to the locale's font.
 */
const ENGLISH_FONT = '"Onest Variable", var(--font-ui)';

function en(key: MessageKey): string {
  return ENGLISH_ENTRY[key] ?? msg(key);
}

/** The setup's answer cards, sized for the space they are set in. */
function Choices({ className, ...props }: React.ComponentProps<typeof QuestionChoices>) {
  return (
    <QuestionChoices
      {...props}
      // The 1px inset keeps the cards' focus ring clear of the scroll clip.
      className={cn(
        "-m-1 min-h-0 overflow-y-auto overscroll-contain border-t-0 p-1",
        "[&>div]:grid-cols-1 [&>div]:gap-2",
        className,
      )}
    />
  );
}

/**
 * The first-login setup, one sequence: the language full screen, then a
 * walk over the real app where each stop explains a part of it and, where
 * it owns a setting, asks it in place (the level first, since it reshapes
 * the page behind). Finishing saves the answers and opens a new
 * optimization; Skip keeps whatever was answered. Shown to every account
 * whose setup is not done; Settings can rerun it.
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
    // Back from the reload a language switch makes: carry on with the tour.
    const resume = takeIntakeResume();
    const stored = readIntakeDraft();
    const draft = resume
      ? resumeAfterLanguageSwitch(stored, resume, locale)
      : (stored ?? emptyDraft());
    // A setup already under way picks up where it was, without the entrance again.
    const stage: Stage = draft.answered.includes("language")
      ? "tour"
      : experience.rerunning
        ? "title"
        : "glance";
    return { draft, stage };
  });
  const [draft, setDraft] = React.useState<IntakeDraft>(initial.draft);
  const [stage, setStage] = React.useState<Stage>(initial.stage);
  const [stopIndex, setStopIndex] = React.useState(0);
  const [finale, setFinale] = React.useState<Finale>("none");
  /** The stop whose question was just answered; it moves on after the hold. */
  const [answeredStop, setAnsweredStop] = React.useState<number | null>(null);
  const { openGuided, setOpen: setSettingsOpen } = useSettingsModal();

  const { answers } = draft;

  React.useEffect(() => {
    writeIntakeDraft(draft);
  }, [draft]);

  React.useEffect(() => {
    if (stage !== "glance" && stage !== "title") return;
    const delay =
      stage === "glance"
        ? APP_GLANCE_MS
        : (reduceMotion ? REDUCED_S * 1000 : TITLE_IN_MS) + TITLE_HOLD_MS;
    const timer = setTimeout(() => setStage(stage === "glance" ? "title" : "language"), delay);
    return () => clearTimeout(timer);
  }, [stage, reduceMotion]);

  // A stop about a setting Settings holds opens it there, framed behind the
  // card; moving on, going back, skipping or finishing closes it again.
  const settingsTab =
    stage === "tour" && finale === "none" ? SETUP_STOPS[stopIndex]!.settings : undefined;
  React.useEffect(() => {
    if (!settingsTab) return;
    openGuided(settingsTab);
    return () => setSettingsOpen(false);
  }, [settingsTab, openGuided, setSettingsOpen]);

  // The tour's first stops are on the dashboard.
  React.useEffect(() => {
    if (stage === "tour" && window.location.pathname !== "/") router.push("/");
  }, [stage, router]);

  /** Record an answer in place. */
  const answer = (phase: "language" | IntakeLlmPhase, patch: Partial<IntakeAnswers> = {}) => {
    setDraft((prev) => ({
      ...prev,
      answers: { ...prev.answers, ...patch },
      answered: markAnswered(prev.answered, [phase]),
    }));
  };

  /** Record a tour stop's answer, then move on once it has shown. */
  const answerStop = (phase: IntakeLlmPhase, patch: Partial<IntakeAnswers> = {}) => {
    answer(phase, patch);
    setAnsweredStop(stopIndex);
  };

  /** Hand an answer to the setting Settings shows behind the card, which saves it. */
  const tellSettings = (detail: SetupSettingDetail) => {
    window.dispatchEvent(new CustomEvent(SETUP_SETTING_EVENT, { detail }));
  };

  const chooseLevel = (level: ExperienceLevel) => {
    setDraft((prev) => ({ ...prev, answers: { ...prev.answers, level, level_chosen: true } }));
    // Saved at once so the page behind re-renders at the new level.
    void experience.save({ level });
    setAnsweredStop(stopIndex);
  };

  /** Write what the user answered; an untouched setting keeps its value. */
  const persist = async (): Promise<IntakeAnswers> => {
    const final: IntakeAnswers = {
      ...answers,
      level: answers.level_chosen ? answers.level : experience.level,
      byok_provider: answers.billing === "byok" ? answers.byok_provider : null,
    };
    if (final.trust) setPref("agentTrustMode", final.trust);
    await Promise.all([
      final.privacy
        ? updateModelPrivacy({ data_policy: final.privacy }).catch(() => undefined)
        : undefined,
      draft.answered.includes("emails")
        ? updateNotificationPreferences(buildNotificationPatch(final.notifications)).catch(
            () => undefined,
          )
        : undefined,
    ]);
    return final;
  };

  const finish = async () => {
    setFinale("splash");
    const hold = new Promise((resolve) => setTimeout(resolve, SUBMIT_SPLASH_HOLD_MS));
    const [, final] = await Promise.all([hold, persist()]);
    // The answers land while the splash still covers the app; marking the
    // setup complete is what unmounts it (and the splash with it), so that
    // waits for the slide out.
    await experience.save({ ...buildExperiencePatch(final), intake_completed: undefined });
    clearIntakeDraft();
    router.push("/submit");
    setFinale("out");
  };

  const closeAfterSlide = () => {
    void experience.save({ intake_completed: true });
    experience.closeIntake();
  };

  const skip = () => {
    clearIntakeDraft();
    // Marked done at once so the setup closes without waiting on the network.
    void experience.save({ intake_completed: true });
    experience.closeIntake();
    void persist().then((final) => experience.save(buildExperiencePatch(final)));
  };

  const chooseLanguage = (next: string) => {
    if (next === locale || !isLocale(next)) {
      answer("language", { language: locale });
      setStopIndex(0);
      setStage("tour");
      return;
    }
    // The switch reloads the page; the draft and its note bring the user back to the tour.
    setDraft(prepareLanguageSwitch(draft, next));
    setLocale(next);
  };

  const stop = SETUP_STOPS[stopIndex]!;

  const goNext = () => {
    setAnsweredStop(null);
    if (stopIndex === SETUP_STOPS.length - 1) void finish();
    else setStopIndex(stopIndex + 1);
  };

  const goBack = () => {
    setAnsweredStop(null);
    if (stopIndex === 0) setStage("language");
    else setStopIndex(stopIndex - 1);
  };

  const advanceAfterAnswer = React.useEffectEvent(() => {
    if (answeredStop === stopIndex) goNext();
  });
  React.useEffect(() => {
    if (answeredStop === null) return;
    const timer = setTimeout(() => advanceAfterAnswer(), ANSWER_HOLD_MS);
    return () => clearTimeout(timer);
  }, [answeredStop]);
  const keepCurrent: InterviewOption = {
    label: msg("experience.intake.chat.keep_current"),
    description: msg("experience.intake.chat.keep_current_description"),
  };

  const renderQuestion = () => {
    switch (stop.question) {
      case "level": {
        const level = answers.level_chosen ? answers.level : null;
        return (
          <Segmented
            value={level}
            onChange={chooseLevel}
            label={msg("experience.level.title")}
            options={EXPERIENCE_LEVELS.map((value) => {
              const LevelIcon = LEVEL_ICONS[value];
              return {
                value,
                label: msg(LEVEL_KEYS[value].label),
                tip: msg(LEVEL_KEYS[value].description),
                icon: (
                  <LevelIcon
                    aria-hidden="true"
                    weight={value === level ? "fill" : "bold"}
                    className={cn(
                      "size-3.5 shrink-0 transition-colors duration-200",
                      value === level ? "text-primary" : "text-current",
                    )}
                  />
                ),
              };
            })}
          />
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
          <Choices
            options={options}
            selected={
              draft.answered.includes("billing")
                ? options[answers.billing === "byok" ? 1 : 0]!.label
                : []
            }
            ariaLabel={msg("experience.intake.billing.title")}
            onSelect={(_, index) =>
              answerStop(
                "billing",
                index === 1 ? { billing: "byok" } : { billing: "platform", byok_provider: null },
              )
            }
          />
        );
      }
      case "privacy": {
        const options: InterviewOption[] = [
          ...PRIVACY_OPTIONS.map((o) => ({ label: msg(o.label), description: msg(o.description) })),
          keepCurrent,
        ];
        const current = PRIVACY_OPTIONS.find((o) => o.value === answers.privacy);
        return (
          <Choices
            options={options}
            selected={
              draft.answered.includes("privacy")
                ? current
                  ? msg(current.label)
                  : keepCurrent.label
                : []
            }
            ariaLabel={msg("experience.intake.privacy.title")}
            onSelect={(_, index) => {
              const privacy = PRIVACY_OPTIONS[index]?.value ?? null;
              answerStop("privacy", { privacy });
              if (privacy) tellSettings({ privacy });
            }}
          />
        );
      }
      case "emails": {
        const options = CADENCE_OPTIONS.map(([, label, tip]) => ({
          label: msg(label),
          description: msg(tip),
        }));
        const current = CADENCE_OPTIONS.find(([value]) => value === answers.notifications.cadence);
        return (
          <Choices
            options={options}
            selected={draft.answered.includes("emails") && current ? msg(current[1]) : []}
            ariaLabel={msg("experience.intake.emails.title")}
            onSelect={(_, index) => {
              const cadence = CADENCE_OPTIONS[index]![0];
              answerStop("emails", { notifications: { ...answers.notifications, cadence } });
              tellSettings({ cadence });
            }}
          />
        );
      }
      case "trust": {
        const options: InterviewOption[] = [
          ...TRUST_OPTIONS.map((o) => ({ label: msg(o.label), description: msg(o.description) })),
          keepCurrent,
        ];
        const current = TRUST_OPTIONS.find((o) => o.value === answers.trust);
        return (
          <Choices
            options={options}
            selected={
              draft.answered.includes("trust")
                ? current
                  ? msg(current.label)
                  : keepCurrent.label
                : []
            }
            ariaLabel={msg("experience.intake.trust.title")}
            onSelect={(_, index) =>
              answerStop("trust", { trust: TRUST_OPTIONS[index]?.value ?? null })
            }
          />
        );
      }
      default:
        return null;
    }
  };

  const splashOverlay = (
    <SubmitSplashOverlay show={finale === "splash"} slideOut onExited={closeAfterSlide} />
  );

  if (stage === "glance") return null;

  if (stage === "tour") {
    return (
      <>
        {finale === "none" && (
          <SetupTour
            stop={stop}
            index={stopIndex}
            total={SETUP_STOPS.length}
            onSkip={skip}
            onBack={goBack}
            onNext={goNext}
          >
            {renderQuestion()}
          </SetupTour>
        )}
        {splashOverlay}
      </>
    );
  }

  const fade: Transition = { duration: REDUCED_S, ease: "easeOut" };
  const splash = (delay = 0, duration = WORDMARK_S): Transition =>
    reduceMotion ? fade : { duration, delay, ease: SPLASH_EASE };
  // One screen hands off to the next with a short rise; a plain fade when motion is unwelcome.
  const step = reduceMotion
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : {
        initial: { opacity: 0, y: 12 },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: 0, y: -12 },
      };
  const stepTransition = splash(0, STEP_S);

  const choices = languageChoices<Locale>("en", FULL_TRANSLATION_LOCALES);
  const languageOptions: InterviewOption[] = choices.map((l) => ({
    label: LOCALE_REGISTRY[l].nativeName,
    description: LOCALE_REGISTRY[l].englishName,
  }));
  // Nothing is marked until the user picks; Continue then keeps the active language.
  const picked =
    draft.answered.includes("language") && isLocale(answers.language) ? answers.language : null;

  const navTip = (label: string, button: React.ReactElement) => (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent dir="ltr">{label}</TooltipContent>
    </Tooltip>
  );

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
            dir="ltr"
            lang="en"
            style={{ zIndex: 50, backgroundColor: SPLASH_GROUND, fontFamily: ENGLISH_FONT }}
            initial={reduceMotion ? { opacity: 0 } : { y: "-100%" }}
            animate={reduceMotion ? { opacity: 1 } : { y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { y: "-100%" }}
            transition={reduceMotion ? fade : { duration: PANEL_S, ease: SPLASH_EASE }}
          >
            <DialogPrimitive.Title className="sr-only">
              {en("experience.intake.entrance.title")}
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
                    className="max-w-[16ch] text-center [font-family:var(--font-display)] [font-optical-sizing:auto] text-[clamp(2.25rem,min(11vw,9dvh),4.5rem)] font-semibold leading-[1.05] tracking-tight text-balance"
                    initial={step.initial}
                    animate={step.animate}
                    transition={splash(TITLE_DELAY_S)}
                  >
                    {en("experience.intake.entrance.title")}
                  </motion.p>
                </motion.div>
              ) : (
                <motion.div
                  key="language"
                  className="flex min-h-0 flex-1 flex-col bg-background"
                  {...step}
                  transition={stepTransition}
                >
                  {/* The question and its buttons sit as one group in the optical
                      middle of the screen; safe centering keeps the top in view
                      when a short screen has no room to spare. */}
                  <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col gap-6 px-5 pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] [justify-content:safe_center] sm:gap-8 sm:px-7 [@media(max-height:700px)]:gap-4">
                    <section className="flex min-h-0 flex-col gap-4 sm:gap-6 [@media(max-height:700px)]:gap-3">
                      <div className="flex flex-col gap-1.5">
                        <h2 className="text-xl font-semibold leading-snug tracking-tight text-balance sm:text-3xl [@media(max-height:700px)]:text-xl">
                          {en("experience.intake.language.title")}
                        </h2>
                        <p className="text-sm leading-relaxed text-muted-foreground sm:text-base [@media(max-height:700px)]:text-sm">
                          {en("experience.intake.language.hint")}
                        </p>
                      </div>
                      <Choices
                        options={languageOptions}
                        selected={(picked && languageOptions[choices.indexOf(picked)]?.label) || []}
                        ariaLabel={en("experience.intake.language.title")}
                        // Seventeen languages fit as a three-column grid (two on a
                        // phone, where each card shows only the language's own name).
                        className="[&>div]:grid-cols-2 sm:[&>div]:grid-cols-3 sm:[&_button]:py-2.5 max-sm:[&_[dir=auto]+[dir=auto]]:hidden [@media(min-height:860px)]:sm:[&_button]:py-3 [@media(max-height:700px)]:[&_button]:py-1.5"
                        onSelect={(_, index) => chooseLanguage(choices[index] ?? locale)}
                      />
                    </section>
                    <div className="flex shrink-0 items-center gap-2">
                      {navTip(
                        en("experience.intake.skip"),
                        <Button
                          variant="ghost"
                          size="icon-lg"
                          className={cn(
                            TOUCH_TAP_SQUARE,
                            "-ms-3 text-muted-foreground hover:text-foreground",
                          )}
                          aria-label={en("experience.intake.skip")}
                          onClick={skip}
                        >
                          <X className="size-4" aria-hidden />
                        </Button>,
                      )}
                      {navTip(
                        en("experience.intake.next"),
                        <Button
                          size="icon-lg"
                          className={cn(TOUCH_TAP_SQUARE, "ms-auto")}
                          aria-label={en("experience.intake.next")}
                          onClick={() => chooseLanguage(picked ?? locale)}
                        >
                          <ArrowRight className="size-4" aria-hidden />
                        </Button>,
                      )}
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
