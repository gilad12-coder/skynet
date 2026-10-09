"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";

import {
  extractWizardPatch,
  queueAgentPrompt,
  useWizardStateOptional,
} from "@/features/agent-panel";
import { BYOK_PROVIDERS } from "@/features/billing";
import { useUserPrefs } from "@/features/settings";
import {
  updateModelPrivacy,
  updateNotificationPreferences,
  type ConnectorProvider,
  type InterviewOption,
} from "@/shared/lib/api";
import { formatMsg, msg, type MessageKey } from "@/shared/lib/messages";
import { getModelCatalog } from "@/shared/lib/model-catalog";
import { FULL_TRANSLATION_LOCALES, LOCALE_REGISTRY, isLocale } from "@/shared/lib/locale";
import { getActiveIntlLocale } from "@/shared/lib/runtime-locale";
import { useLocale } from "@/shared/providers";
import { cn } from "@/shared/lib/utils";
import { QuestionChoices } from "@/shared/ui/agent";
import { NumberInput } from "@/shared/ui/number-input";
import { Button } from "@/shared/ui/primitives/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/shared/ui/primitives/dialog";
import { Input } from "@/shared/ui/primitives/input";
import { TOUCH_FIELD } from "@/shared/ui/touch";
import type { CatalogModel, ModelDataPolicy } from "@/shared/types/api";

import type { ExperienceLevel } from "../lib/abstraction";
import {
  BUDGET_PRESETS_USD,
  SKIP_PATCH,
  agentBrief,
  applyInterviewTurn,
  buildExperiencePatch,
  buildNotificationPatch,
  buildWizardPrefill,
  classifySourceText,
  clearIntakeDraft,
  connectorFor,
  effectiveLevel,
  emptyDraft,
  goalLine,
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
  visiblePhases,
  writeIntakeDraft,
  type IntakeAnswers,
  type IntakeAutoManual,
  type IntakeDraft,
  type IntakePhase,
  type IntakeSourceKind,
  type IntakeTrustMode,
} from "../lib/intake";
import { useExperienceOptional } from "../providers/experience-provider";
import { levelDescription, levelLabel } from "./ExperienceLevelControl";
import { IntakeConnect } from "./IntakeConnect";
import { IntakeInterview } from "./IntakeInterview";
import { IntakeKeyCheck } from "./IntakeKeyCheck";
import { LevelSlider } from "./LevelSlider";
import { NotificationCadenceFields } from "./NotificationCadenceFields";
import { TOUCH_TAP } from "./touch";

const MAX_MODEL_OPTIONS = 6;

const PHASE_LABELS: Record<IntakePhase, MessageKey> = {
  language: "experience.intake.phase.language",
  goal: "experience.intake.phase.goal",
  source: "experience.intake.phase.source",
  models: "experience.intake.phase.models",
  billing: "experience.intake.phase.billing",
  budget: "experience.intake.phase.budget",
  privacy: "experience.intake.phase.privacy",
  emails: "experience.intake.phase.emails",
  trust: "experience.intake.phase.trust",
  defaults: "experience.intake.phase.defaults",
  level: "experience.intake.phase.level",
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

const SOURCE_LABELS: Record<IntakeSourceKind, MessageKey> = {
  repo: "experience.intake.source.repo",
  api: "experience.intake.source.api",
  spreadsheet: "experience.intake.q2.option.spreadsheet",
  file: "experience.intake.q2.option.file",
  dataset: "experience.intake.q2.option.dataset",
  none: "experience.intake.q2.option.none",
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

const CODE_ASSIST_OPTIONS: ReadonlyArray<readonly [IntakeAutoManual, MessageKey, MessageKey]> = [
  ["auto", "settings.wizard.code_assist.auto", "experience.intake.defaults.code_auto_description"],
  [
    "manual",
    "settings.wizard.code_assist.manual",
    "experience.intake.defaults.code_manual_description",
  ],
];

const SPLIT_OPTIONS: ReadonlyArray<readonly [IntakeAutoManual, MessageKey, MessageKey]> = [
  ["auto", "settings.wizard.split_mode.auto", "experience.intake.defaults.split_auto_description"],
  [
    "manual",
    "settings.wizard.split_mode.manual",
    "experience.intake.defaults.split_manual_description",
  ],
];

const LEVELS: readonly ExperienceLevel[] = ["guided", "standard", "expert"];

const BUDGET_DESCRIPTIONS: Record<number, MessageKey> = {
  20: "experience.intake.budget.preset_20",
  5: "experience.intake.budget.preset_5",
  50: "experience.intake.budget.preset_50",
};

function usd(amount: number): string {
  return new Intl.NumberFormat(getActiveIntlLocale(), {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(amount);
}

/** The agenda as a bar, the current question named above it. */
function IntakeProgress({ index, total, label }: { index: number; total: number; label: string }) {
  return (
    <div className="px-5 pt-5 sm:px-7">
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
      <p className="pt-2 text-xs text-muted-foreground" aria-live="polite">
        {label}
      </p>
    </div>
  );
}

/** The question carries the screen; the hint sits tight beneath it. */
function QuestionHeading({
  titleId,
  title,
  hint,
  className,
}: {
  titleId: string;
  title: string;
  hint: string;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <DialogTitle
        id={titleId}
        className="text-lg font-semibold leading-snug tracking-tight text-balance sm:text-xl"
      >
        {title}
      </DialogTitle>
      <DialogDescription className="text-sm leading-relaxed text-muted-foreground">
        {hint}
      </DialogDescription>
    </div>
  );
}

/** The interview's answer cards, set in the question screen instead of under a chat. */
function Choices(props: React.ComponentProps<typeof QuestionChoices>) {
  return <QuestionChoices {...props} className="border-t-0 px-0 pt-0" />;
}

/** One editable line of the summary. */
function SummaryRow({
  label,
  hint,
  onChange,
  children,
}: {
  label: string;
  hint?: string;
  onChange?: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 border-b border-border/40 py-3 last:border-b-0">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-medium text-foreground">{label}</span>
          {hint && (
            <span className="text-xs text-muted-foreground/80" dir="auto">
              {hint}
            </span>
          )}
        </div>
        {onChange && (
          <Button
            variant="ghost"
            size="sm"
            className={cn(TOUCH_TAP, "-me-2 shrink-0")}
            onClick={onChange}
          >
            {msg("experience.intake.summary.change")}
          </Button>
        )}
      </div>
      {children}
    </div>
  );
}

/**
 * The first-login setup: a short interview (a language model asks what to
 * improve and where it lives, the rest are fixed multiple-choice cards),
 * then a summary the user can edit, then the wizard opens filled in. When the
 * interviewer is unavailable the open questions turn into fixed ones too.
 * Shown to every account whose setup is not done, before the tour; Settings
 * can rerun it.
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
  if (!experience || !open || bare) return null;
  return <IntakeDialog agentEnabled={agentEnabled} />;
}

function IntakeDialog({ agentEnabled }: { agentEnabled: boolean }) {
  const experience = useExperienceOptional()!;
  const wizard = useWizardStateOptional();
  const { setPref } = useUserPrefs();
  const router = useRouter();
  const { locale, setLocale } = useLocale();
  const titleId = React.useId();

  const [draft, setDraft] = React.useState<IntakeDraft>(() => {
    // Back from the reload a language switch makes: carry on at the next question.
    const resume = takeIntakeResume();
    const stored = readIntakeDraft();
    return resume ? resumeAfterLanguageSwitch(stored, resume, locale) : (stored ?? emptyDraft());
  });
  const [fallbackNote, setFallbackNote] = React.useState(false);
  const [models, setModels] = React.useState<CatalogModel[] | null>(null);
  const [modelsFailed, setModelsFailed] = React.useState(false);
  const [finishing, setFinishing] = React.useState(false);

  const { answers, screen, answered } = draft;
  const fixed = draft.fixed || !agentEnabled;
  const [sourceText, setSourceText] = React.useState(() => answers.source_url);

  React.useEffect(() => {
    writeIntakeDraft(draft);
  }, [draft]);

  React.useEffect(() => {
    let cancelled = false;
    getModelCatalog()
      .then((catalog) => {
        if (cancelled) return;
        const featured = catalog.models.filter((m) => m.featured);
        setModels((featured.length > 0 ? featured : catalog.models).slice(0, MAX_MODEL_OPTIONS));
      })
      .catch(() => {
        if (!cancelled) setModelsFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
      const nextAnswers = { ...prev.answers, ...patch };
      const nextAnswered = markAnswered(prev.answered, [phase]);
      return {
        ...prev,
        answers: nextAnswers,
        answered: nextAnswered,
        screen: nextPhase(nextAnswers, nextAnswered, phase) ?? "summary",
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
  const connector: ConnectorProvider | null = connectorFor(answers.source);
  const level = effectiveLevel(answers);

  const setSourceFromText = (text: string) => {
    setSourceText(text);
    const hit = classifySourceText(text);
    if (hit) {
      update({ source: hit.kind, source_url: hit.value, connector: "none" });
    } else if (answers.source === "repo" || answers.source === "api") {
      update({ source: null, source_url: "", connector: "none" });
    }
  };

  const modelLabel = (value: string) => models?.find((m) => m.value === value)?.label ?? value;

  const byokProvider =
    answers.byok_provider ??
    BYOK_PROVIDERS.find(
      (p) => models?.find((m) => m.value === answers.models[0])?.provider === p.slug,
    )?.slug ??
    BYOK_PROVIDERS[0]!.slug;

  const finish = async () => {
    setFinishing(true);
    const final: IntakeAnswers = {
      ...answers,
      level,
      byok_provider: answers.billing === "byok" ? byokProvider : null,
    };
    // Only answers the user gave are written; an untouched setting keeps its value.
    if (final.trust) setPref("agentTrustMode", final.trust);
    if (final.code_assist) setPref("wizardCodeAssist", final.code_assist);
    if (final.split_mode) setPref("wizardSplitMode", final.split_mode);
    if (final.privacy) {
      await updateModelPrivacy({ data_policy: final.privacy }).catch(() => undefined);
    }
    // Notifications before the experience PATCH, which closes the dialog.
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

  const phases = visiblePhases(answers, answered);
  const interviewing =
    screen !== "summary" && isLlmPhase(screen) && !fixed && !answered.includes(screen);
  const back = previousScreen(answers, answered, screen);
  const progressIndex = screen === "summary" ? phases.length : phases.indexOf(screen);
  const progressLabel =
    screen === "summary"
      ? msg("experience.intake.summary.eyebrow")
      : `${msg(PHASE_LABELS[screen])} · ${formatMsg("experience.intake.step", {
          n: progressIndex + 1,
          total: phases.length,
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

  const renderQuestion = (phase: IntakePhase) => {
    switch (phase) {
      case "language": {
        const choices = languageChoices(locale, FULL_TRANSLATION_LOCALES);
        const options: InterviewOption[] = [
          ...choices.map((l, index) => ({
            label:
              index === 0
                ? formatMsg("experience.intake.language.keep", {
                    language: LOCALE_REGISTRY[l].nativeName,
                  })
                : LOCALE_REGISTRY[l].nativeName,
            description:
              index === 0
                ? msg("experience.intake.language.keep_description")
                : LOCALE_REGISTRY[l].englishName,
          })),
          {
            label: msg("experience.intake.language.default"),
            description: msg("experience.intake.language.default_description"),
          },
        ];
        const picked = isLocale(answers.language) ? answers.language : locale;
        return (
          <section className="flex flex-col gap-6">
            <QuestionHeading
              titleId={titleId}
              title={msg("experience.intake.language.title")}
              hint={msg("experience.intake.language.hint")}
            />
            <Choices
              options={options}
              selected={options[Math.max(0, choices.indexOf(picked))]!.label}
              ariaLabel={msg("experience.intake.language.title")}
              onSelect={(_, index) => {
                const next = choices[index] ?? locale;
                if (next === locale) {
                  answer("language", { language: locale });
                  return;
                }
                // The switch reloads the page; the draft and its note bring the user back here.
                setDraft(prepareLanguageSwitch(draft, next));
                setLocale(next);
              }}
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
              titleId={titleId}
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
              titleId={titleId}
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
                    connector: "none",
                  });
                }}
              />
            </div>
          </section>
        );
      }
      case "models": {
        const wizardPicks: InterviewOption = {
          label: msg("experience.intake.summary.models_none"),
          description: msg("experience.intake.models.default_description"),
        };
        const options: InterviewOption[] = [
          ...(models ?? []).map((m) => ({
            label: m.label,
            description:
              BYOK_PROVIDERS.find((p) => p.slug === m.provider)?.label ?? m.provider ?? "",
          })),
          wizardPicks,
        ];
        return (
          <section className="flex flex-col gap-6">
            <QuestionHeading
              titleId={titleId}
              title={msg("experience.intake.models.title")}
              hint={msg("experience.intake.q3.hint")}
            />
            <div className="flex flex-col gap-3">
              {models === null && !modelsFailed && (
                <p className="text-xs text-muted-foreground" role="status">
                  {msg("experience.intake.q3.models_loading")}
                </p>
              )}
              {(modelsFailed || models?.length === 0) && (
                <p className="text-xs text-muted-foreground">
                  {msg("experience.intake.q3.models_empty")}
                </p>
              )}
              <Choices
                options={options}
                selected={
                  answers.models.length === 0
                    ? wizardPicks.label
                    : answers.models.map((value) => modelLabel(value))
                }
                ariaLabel={msg("experience.intake.q3.models_label")}
                onSelect={(_, index) => {
                  const model = models?.[index];
                  // Several models may be picked; Continue confirms them.
                  update({
                    models: !model
                      ? []
                      : answers.models.includes(model.value)
                        ? answers.models.filter((m) => m !== model.value)
                        : [...answers.models, model.value],
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
              titleId={titleId}
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
              titleId={titleId}
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
              titleId={titleId}
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
              titleId={titleId}
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
              titleId={titleId}
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
      case "defaults": {
        const group = (
          title: MessageKey,
          rows: ReadonlyArray<readonly [IntakeAutoManual, MessageKey, MessageKey]>,
          value: IntakeAutoManual | null,
          onPick: (v: IntakeAutoManual) => void,
        ) => (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium text-foreground">{msg(title)}</p>
            <Choices
              options={rows.map(([, label, description]) => ({
                label: msg(label),
                description: msg(description),
              }))}
              selected={rows.filter(([v]) => v === value).map(([, label]) => msg(label))}
              ariaLabel={msg(title)}
              onSelect={(_, index) => onPick(rows[index]![0])}
            />
          </div>
        );
        return (
          <section className="flex flex-col gap-6">
            <QuestionHeading
              titleId={titleId}
              title={msg("experience.intake.phase.defaults")}
              hint={msg("experience.intake.defaults.hint")}
            />
            {group(
              "experience.intake.defaults.code_title",
              CODE_ASSIST_OPTIONS,
              answers.code_assist,
              (v) => update({ code_assist: v }),
            )}
            {group(
              "experience.intake.defaults.split_title",
              SPLIT_OPTIONS,
              answers.split_mode,
              (v) => update({ split_mode: v }),
            )}
          </section>
        );
      }
      case "level": {
        const options = LEVELS.map((l) => ({
          label: levelLabel(l),
          description: levelDescription(l),
        }));
        return (
          <section className="flex flex-col gap-6">
            <QuestionHeading
              titleId={titleId}
              title={msg("experience.intake.level.title")}
              hint={msg("experience.level.subtitle")}
            />
            <Choices
              options={options}
              selected={levelLabel(level)}
              ariaLabel={msg("experience.intake.level.title")}
              onSelect={(_, index) =>
                answer("level", { level: LEVELS[index]!, level_chosen: true })
              }
            />
          </section>
        );
      }
    }
  };

  const modelSummary =
    answers.models.length === 0
      ? msg("experience.intake.summary.models_none")
      : answers.models.map(modelLabel).join(", ");
  const billingSummary =
    answers.billing === "byok"
      ? formatMsg("experience.intake.summary.billing_byok", {
          provider: BYOK_PROVIDERS.find((p) => p.slug === byokProvider)?.label ?? byokProvider,
        })
      : msg("experience.intake.summary.billing_platform");
  const privacyOption = PRIVACY_OPTIONS.find((o) => o.value === answers.privacy);
  const trustOption = TRUST_OPTIONS.find((o) => o.value === answers.trust);
  const defaultsSummary = [
    CODE_ASSIST_OPTIONS.find(([v]) => v === answers.code_assist)?.[1],
    SPLIT_OPTIONS.find(([v]) => v === answers.split_mode)?.[1],
  ]
    .filter((key): key is MessageKey => !!key)
    .map((key) => msg(key))
    .join(" · ");

  const summary = (
    <section className="flex flex-col">
      <QuestionHeading
        titleId={titleId}
        title={msg("experience.intake.summary.title")}
        hint={
          agentEnabled
            ? msg("experience.intake.summary.agent_on")
            : msg("experience.intake.summary.agent_off")
        }
        className="pb-3"
      />

      <SummaryRow
        label={msg("experience.intake.phase.language")}
        hint={LOCALE_REGISTRY[isLocale(answers.language) ? answers.language : locale].nativeName}
        onChange={() => goTo("language")}
      />

      <SummaryRow
        label={msg("experience.intake.summary.goal")}
        hint={goalLine(answers) || msg("experience.intake.summary.goal_none")}
        onChange={() => goTo("goal")}
      />

      <SummaryRow
        label={msg("experience.level.title")}
        hint={
          answers.level_chosen
            ? levelDescription(level)
            : formatMsg("experience.intake.summary.level_inferred", { level: levelLabel(level) })
        }
      >
        <LevelSlider
          value={level}
          onChange={(next) => update({ level: next, level_chosen: true })}
          label={msg("experience.level.title")}
        />
      </SummaryRow>

      <SummaryRow
        label={msg("experience.intake.summary.source")}
        hint={answers.source ? answers.source_url || msg(SOURCE_LABELS[answers.source]) : undefined}
        onChange={() => goTo("source")}
      >
        {connector ? (
          <IntakeConnect
            provider={connector}
            state={answers.connector}
            onState={(state) => update({ connector: state })}
            beforeRedirect={() => writeIntakeDraft(draft)}
          />
        ) : (
          answers.source &&
          answers.source !== "none" && (
            <p className="text-xs text-muted-foreground">
              {answers.source === "api"
                ? msg("experience.intake.q2.api_note")
                : msg("experience.intake.q2.file_note")}
            </p>
          )
        )}
      </SummaryRow>

      <SummaryRow
        label={msg("experience.intake.summary.models")}
        hint={`${modelSummary} · ${billingSummary}`}
        onChange={() => goTo("models")}
      >
        {answers.billing === "byok" && (
          <IntakeKeyCheck
            provider={byokProvider}
            onProvider={(slug) => update({ byok_provider: slug })}
            onVerified={() => update({ byok_provider: byokProvider })}
            onUsePlatform={() => update({ billing: "platform", byok_provider: null })}
          />
        )}
      </SummaryRow>

      <SummaryRow
        label={msg("experience.intake.summary.limit")}
        hint={msg("experience.intake.summary.limit_hint")}
      >
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{msg("experience.intake.summary.limit_usd")}</span>
          <NumberInput
            size="sm"
            className="w-28"
            value={answers.spending_limit_cents === null ? "" : answers.spending_limit_cents / 100}
            min={1}
            max={10000}
            step={1}
            onChange={(amount) => update({ spending_limit_cents: Math.round(amount * 100) })}
            onClear={() => update({ spending_limit_cents: null })}
          />
        </label>
      </SummaryRow>

      {privacyOption && (
        <SummaryRow
          label={msg("experience.intake.phase.privacy")}
          hint={msg(privacyOption.label)}
          onChange={() => goTo("privacy")}
        />
      )}
      {trustOption && (
        <SummaryRow
          label={msg("experience.intake.phase.trust")}
          hint={msg(trustOption.label)}
          onChange={() => goTo("trust")}
        />
      )}
      {defaultsSummary && (
        <SummaryRow
          label={msg("experience.intake.phase.defaults")}
          hint={defaultsSummary}
          onChange={() => goTo("defaults")}
        />
      )}

      <SummaryRow label={msg("experience.intake.summary.notify")}>
        <NotificationCadenceFields
          idPrefix="intake-notify"
          value={answers.notifications}
          onChange={(patch) => update({ notifications: { ...answers.notifications, ...patch } })}
        />
      </SummaryRow>
    </section>
  );

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !finishing) skip();
      }}
    >
      <DialogContent
        aria-labelledby={titleId}
        className={cn(
          "flex max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl",
          interviewing && "h-[min(40rem,calc(100dvh-1rem))]",
        )}
        showCloseButton={false}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <IntakeProgress index={progressIndex} total={phases.length + 1} label={progressLabel} />

        {interviewing ? (
          <>
            <div className="px-5 pt-4 sm:px-7">
              <QuestionHeading
                titleId={titleId}
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
          </>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pt-6 pb-8 sm:px-7 sm:pt-7">
            {fallbackNote && (
              <p className="pb-4 text-xs text-muted-foreground" role="status">
                {msg("experience.intake.chat.error")}
              </p>
            )}
            {screen === "summary" ? summary : renderQuestion(screen)}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-border/40 px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-7">
          {/* Leaving sits apart from moving forward, so neither is hit by mistake. */}
          <Button
            variant="ghost"
            className={cn(TOUCH_TAP, "-ms-3 text-muted-foreground hover:text-foreground")}
            onClick={skip}
            disabled={finishing}
          >
            {msg("experience.intake.skip")}
          </Button>
          <div className="ms-auto flex items-center gap-2">
            {back && (
              <Button
                variant="ghost"
                className={TOUCH_TAP}
                onClick={() => goTo(back)}
                disabled={finishing}
              >
                {msg("experience.intake.back")}
              </Button>
            )}
            {screen === "summary" ? (
              <Button className={TOUCH_TAP} onClick={() => void finish()} disabled={finishing}>
                {finishing ? msg("experience.intake.finishing") : msg("experience.intake.finish")}
              </Button>
            ) : (
              !interviewing && (
                <Button
                  className={TOUCH_TAP}
                  onClick={() => answer(screen)}
                  disabled={!canContinue}
                >
                  {msg("experience.intake.next")}
                </Button>
              )
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
