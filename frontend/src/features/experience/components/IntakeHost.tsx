"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";

import {
  extractWizardPatch,
  queueAgentPrompt,
  useWizardStateOptional,
} from "@/features/agent-panel";
import { BYOK_PROVIDERS } from "@/features/billing";
import { updateNotificationPreferences, type ConnectorProvider } from "@/shared/lib/api";
import { formatMsg, msg, type MessageKey } from "@/shared/lib/messages";
import { getModelCatalog } from "@/shared/lib/model-catalog";
import { cn } from "@/shared/lib/utils";
import { NumberInput } from "@/shared/ui/number-input";
import { Button } from "@/shared/ui/primitives/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/shared/ui/primitives/dialog";
import { Input } from "@/shared/ui/primitives/input";
import { Segmented, type SegmentedOption } from "@/shared/ui/segmented";
import { TOUCH_FIELD } from "@/shared/ui/touch";
import type { CatalogModel } from "@/shared/types/api";

import type { ExperienceLevel } from "../lib/abstraction";
import {
  SKIP_PATCH,
  agentBrief,
  buildExperiencePatch,
  buildNotificationPatch,
  buildWizardPrefill,
  classifySourceText,
  connectorFor,
  emptyIntake,
  inferLevel,
  parseIntakeAnswers,
  recipeFor,
  type IntakeAnswers,
  type IntakeSourceKind,
} from "../lib/intake";
import { useExperienceOptional } from "../providers/experience-provider";
import { levelDescription, levelLabel, levelOptions } from "./ExperienceLevelControl";
import { IntakeConnect } from "./IntakeConnect";
import { IntakeKeyCheck } from "./IntakeKeyCheck";
import { NotificationCadenceFields } from "./NotificationCadenceFields";
import { TOUCH_TAP } from "./touch";

/*
 * Answers survive the connector's OAuth round trip (the redirect leaves the
 * page) and a reload mid-setup; finishing or skipping clears them.
 */
const DRAFT_KEY = "skynet.intake.draft";
const DRAFT_STEP_KEY = "skynet.intake.draft-step";
const STEPS = 3;
const MAX_MODEL_CHIPS = 6;

function readDraft(): { answers: IntakeAnswers; step: number } | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    const answers = raw ? parseIntakeAnswers(JSON.parse(raw)) : null;
    if (!answers) return null;
    const step = Number(sessionStorage.getItem(DRAFT_STEP_KEY) ?? "0");
    return { answers, step: Number.isInteger(step) && step >= 0 && step <= STEPS ? step : 0 };
  } catch {
    return null;
  }
}

function writeDraft(answers: IntakeAnswers, step: number) {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(answers));
    sessionStorage.setItem(DRAFT_STEP_KEY, String(step));
  } catch {
    // Without storage an OAuth round trip restarts the setup; nothing breaks.
  }
}

function clearDraft() {
  try {
    sessionStorage.removeItem(DRAFT_KEY);
    sessionStorage.removeItem(DRAFT_STEP_KEY);
  } catch {
    // Nothing stored to clear.
  }
}

const GOAL_CHIPS = [
  "experience.intake.q1.chip.classify",
  "experience.intake.q1.chip.extract",
  "experience.intake.q1.chip.agent",
] as const satisfies readonly MessageKey[];

const SOURCE_CHIPS = [
  { source: "spreadsheet", label: "experience.intake.q2.chip.spreadsheet" },
  { source: "file", label: "experience.intake.q2.chip.file" },
  { source: "dataset", label: "experience.intake.q2.chip.dataset" },
] as const satisfies ReadonlyArray<{ source: IntakeSourceKind; label: MessageKey }>;

const SOURCE_LABELS: Record<IntakeSourceKind, MessageKey> = {
  repo: "experience.intake.source.repo",
  api: "experience.intake.source.api",
  spreadsheet: "experience.intake.q2.chip.spreadsheet",
  file: "experience.intake.q2.chip.file",
  dataset: "experience.intake.q2.chip.dataset",
};

/** A one-tap suggestion; pressed when it is the current answer. */
function Chip({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        TOUCH_TAP,
        "cursor-pointer rounded-full border px-3 py-1 text-xs font-medium transition-colors duration-150",
        "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        pressed
          ? "border-foreground/25 bg-accent text-foreground"
          : "border-border/60 text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
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
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 border-b border-border/40 py-3 last:border-b-0">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-medium text-foreground">{label}</span>
          {hint && <span className="text-xs text-muted-foreground/80">{hint}</span>}
        </div>
        {onChange && (
          <Button variant="ghost" size="sm" className={cn(TOUCH_TAP, "-me-2 shrink-0")} onClick={onChange}>
            {msg("experience.intake.summary.change")}
          </Button>
        )}
      </div>
      {children}
    </div>
  );
}

/**
 * The first-login setup: three questions a sharp engineer would ask, then a
 * summary the user can edit, then the wizard opens filled in. Shown to every
 * account whose setup is not done, before the tour; Settings can rerun it.
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
  const router = useRouter();
  const titleId = React.useId();

  const [answers, setAnswers] = React.useState<IntakeAnswers>(
    () => readDraft()?.answers ?? experience.intake ?? emptyIntake(),
  );
  const [step, setStep] = React.useState(() => readDraft()?.step ?? 0);
  const [sourceText, setSourceText] = React.useState(() => answers.source_url);
  const [models, setModels] = React.useState<CatalogModel[] | null>(null);
  const [modelsFailed, setModelsFailed] = React.useState(false);
  const [finishing, setFinishing] = React.useState(false);

  const update = React.useCallback(
    (patch: Partial<IntakeAnswers>) => setAnswers((prev) => ({ ...prev, ...patch })),
    [],
  );

  React.useEffect(() => {
    writeDraft(answers, step);
  }, [answers, step]);

  React.useEffect(() => {
    let cancelled = false;
    getModelCatalog()
      .then((catalog) => {
        if (cancelled) return;
        const featured = catalog.models.filter((m) => m.featured);
        setModels((featured.length > 0 ? featured : catalog.models).slice(0, MAX_MODEL_CHIPS));
      })
      .catch(() => {
        if (!cancelled) setModelsFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The summary opens on the level the answers point to, until the user picks one.
  React.useEffect(() => {
    if (step === STEPS && !answers.level_chosen) {
      const inferred = inferLevel(answers);
      if (inferred !== answers.level) update({ level: inferred });
    }
  }, [step, answers.goal, answers.source, answers.level_chosen]);

  const detected = classifySourceText(sourceText);
  const connector: ConnectorProvider | null = connectorFor(answers.source);

  const setSourceFromText = (text: string) => {
    setSourceText(text);
    const hit = classifySourceText(text);
    if (hit) {
      update({ source: hit.kind, source_url: hit.value, connector: "none" });
    } else if (answers.source === "repo" || answers.source === "api") {
      update({ source: null, source_url: "", connector: "none" });
    }
  };

  const toggleModel = (value: string) =>
    setAnswers((prev) => ({
      ...prev,
      models: prev.models.includes(value)
        ? prev.models.filter((m) => m !== value)
        : [...prev.models, value],
    }));

  const byokProvider =
    answers.byok_provider ??
    BYOK_PROVIDERS.find((p) => models?.find((m) => m.value === answers.models[0])?.provider === p.slug)
      ?.slug ??
    BYOK_PROVIDERS[0]!.slug;

  const finish = async () => {
    setFinishing(true);
    const final = { ...answers, byok_provider: answers.billing === "byok" ? byokProvider : null };
    // Notifications first: the experience PATCH closes the dialog.
    await updateNotificationPreferences(buildNotificationPatch(final.notifications)).catch(
      () => undefined,
    );
    await experience.save(buildExperiencePatch(final));
    wizard?.applyAgentPatch(extractWizardPatch(buildWizardPrefill(final)));
    if (agentEnabled) {
      const brief = agentBrief(final, (values) => formatMsg("experience.intake.agent_brief", values));
      if (brief) queueAgentPrompt(brief);
    }
    clearDraft();
    experience.closeIntake();
    router.push(`/submit?recipe=${recipeFor(final.source)}`);
  };

  const skip = () => {
    clearDraft();
    // A rerun that is dismissed keeps the level the user already had.
    void experience.save(experience.rerunning ? { intake_completed: true } : SKIP_PATCH);
    experience.closeIntake();
  };

  const canContinue =
    step === 0 ? answers.goal.trim().length > 0 : step === 1 ? answers.source !== null : true;

  const levelChoices: Array<SegmentedOption<ExperienceLevel>> = levelOptions();
  const billingOptions: Array<SegmentedOption<"platform" | "byok">> = [
    { value: "platform", label: msg("experience.intake.q3.billing.platform") },
    { value: "byok", label: msg("experience.intake.q3.billing.byok") },
  ];

  const modelSummary =
    answers.models.length === 0
      ? msg("experience.intake.summary.models_none")
      : answers.models
          .map((value) => models?.find((m) => m.value === value)?.label ?? value)
          .join(", ");
  const billingSummary =
    answers.billing === "byok"
      ? formatMsg("experience.intake.summary.billing_byok", {
          provider: BYOK_PROVIDERS.find((p) => p.slug === byokProvider)?.label ?? byokProvider,
        })
      : msg("experience.intake.summary.billing_platform");

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
        )}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border/40 px-4 py-3 pe-14 sm:px-5">
          <span className="text-xs font-medium text-muted-foreground tabular-nums" aria-live="polite">
            {step < STEPS
              ? formatMsg("experience.intake.step", { n: step + 1, total: STEPS })
              : msg("experience.intake.summary.eyebrow")}
          </span>
          <Button
            variant="link"
            size="sm"
            className={cn(TOUCH_TAP, "h-auto px-0 text-muted-foreground")}
            onClick={skip}
            disabled={finishing}
          >
            {msg("experience.intake.skip")}
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-5">
          {step === 0 && (
            <section className="flex flex-col gap-3">
              <DialogTitle id={titleId} className="text-base leading-snug text-balance">
                {msg("experience.intake.q1.title")}
              </DialogTitle>
              <DialogDescription className="text-sm text-muted-foreground">
                {msg("experience.intake.q1.hint")}
              </DialogDescription>
              <Input
                autoFocus
                value={answers.goal}
                placeholder={msg("experience.intake.q1.placeholder")}
                aria-label={msg("experience.intake.q1.title")}
                onChange={(e) => update({ goal: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canContinue) setStep(1);
                }}
                className={cn(TOUCH_FIELD, "text-sm")}
              />
              <div className="flex flex-wrap gap-1.5">
                {GOAL_CHIPS.map((key) => {
                  const text = msg(key);
                  return (
                    <Chip key={key} pressed={answers.goal === text} onClick={() => update({ goal: text })}>
                      {text}
                    </Chip>
                  );
                })}
              </div>
            </section>
          )}

          {step === 1 && (
            <section className="flex flex-col gap-3">
              <DialogTitle id={titleId} className="text-base leading-snug text-balance">
                {msg("experience.intake.q2.title")}
              </DialogTitle>
              <DialogDescription className="text-sm text-muted-foreground">
                {msg("experience.intake.q2.hint")}
              </DialogDescription>
              <Input
                autoFocus
                dir="ltr"
                inputMode="url"
                value={sourceText}
                placeholder={msg("experience.intake.q2.placeholder")}
                aria-label={msg("experience.intake.q2.title")}
                onChange={(e) => setSourceFromText(e.target.value)}
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
              <div className="flex flex-wrap gap-1.5">
                {SOURCE_CHIPS.map((chip) => (
                  <Chip
                    key={chip.source}
                    pressed={answers.source === chip.source}
                    onClick={() => {
                      setSourceText("");
                      update({ source: chip.source, source_url: "", connector: "none" });
                    }}
                  >
                    {msg(chip.label)}
                  </Chip>
                ))}
              </div>
              {connector ? (
                <IntakeConnect
                  provider={connector}
                  state={answers.connector}
                  onState={(state) => update({ connector: state })}
                  beforeRedirect={() => writeDraft(answers, step)}
                />
              ) : (
                answers.source && (
                  <p className="text-xs text-muted-foreground">
                    {answers.source === "api"
                      ? msg("experience.intake.q2.api_note")
                      : msg("experience.intake.q2.file_note")}
                  </p>
                )
              )}
            </section>
          )}

          {step === 2 && (
            <section className="flex flex-col gap-3">
              <DialogTitle id={titleId} className="text-base leading-snug text-balance">
                {msg("experience.intake.q3.title")}
              </DialogTitle>
              <DialogDescription className="text-sm text-muted-foreground">
                {msg("experience.intake.q3.hint")}
              </DialogDescription>
              <div
                className="flex flex-wrap gap-1.5"
                role="group"
                aria-label={msg("experience.intake.q3.models_label")}
              >
                {models === null && !modelsFailed && (
                  <span className="text-xs text-muted-foreground" role="status">
                    {msg("experience.intake.q3.models_loading")}
                  </span>
                )}
                {(modelsFailed || models?.length === 0) && (
                  <span className="text-xs text-muted-foreground">
                    {msg("experience.intake.q3.models_empty")}
                  </span>
                )}
                {models?.map((model) => (
                  <Chip
                    key={model.value}
                    pressed={answers.models.includes(model.value)}
                    onClick={() => toggleModel(model.value)}
                  >
                    {model.label}
                  </Chip>
                ))}
              </div>
              <Segmented<"platform" | "byok">
                value={answers.billing}
                onChange={(billing) => update({ billing })}
                options={billingOptions}
                label={msg("experience.intake.q3.billing.label")}
                size="sm"
                className="w-full"
              />
              {answers.billing === "byok" && (
                <IntakeKeyCheck
                  provider={byokProvider}
                  onProvider={(slug) => update({ byok_provider: slug })}
                  onVerified={() => update({ byok_provider: byokProvider })}
                  onUsePlatform={() => update({ billing: "platform", byok_provider: null })}
                />
              )}
            </section>
          )}

          {step === STEPS && (
            <section className="flex flex-col">
              <DialogTitle id={titleId} className="text-base leading-snug">
                {msg("experience.intake.summary.title")}
              </DialogTitle>
              <DialogDescription className="pt-1 pb-2 text-sm text-muted-foreground">
                {agentEnabled
                  ? msg("experience.intake.summary.agent_on")
                  : msg("experience.intake.summary.agent_off")}
              </DialogDescription>

              <SummaryRow
                label={msg("experience.level.title")}
                hint={
                  answers.level_chosen
                    ? levelDescription(answers.level)
                    : formatMsg("experience.intake.summary.level_inferred", {
                        level: levelLabel(answers.level),
                      })
                }
              >
                <Segmented<ExperienceLevel>
                  value={answers.level}
                  onChange={(level) => update({ level, level_chosen: true })}
                  options={levelChoices}
                  label={msg("experience.level.title")}
                  size="sm"
                  className="w-full"
                />
              </SummaryRow>

              <SummaryRow
                label={msg("experience.intake.summary.source")}
                hint={
                  answers.source
                    ? [
                        answers.source_url || msg(SOURCE_LABELS[answers.source]),
                        connector
                          ? answers.connector === "connected"
                            ? msg("experience.connector.connected")
                            : msg("experience.connector.later")
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")
                    : undefined
                }
                onChange={() => setStep(1)}
              >
                {null}
              </SummaryRow>

              <SummaryRow
                label={msg("experience.intake.summary.models")}
                hint={`${modelSummary} · ${billingSummary}`}
                onChange={() => setStep(2)}
              >
                {null}
              </SummaryRow>

              <SummaryRow
                label={msg("experience.intake.summary.limit")}
                hint={msg("experience.intake.summary.limit_hint")}
              >
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{msg("experience.intake.summary.limit_usd")}</span>
                    <NumberInput
                      size="sm"
                      className="w-28"
                      value={
                        answers.spending_limit_cents === null ? "" : answers.spending_limit_cents / 100
                      }
                      min={1}
                      max={10000}
                      step={1}
                      onChange={(usd) => update({ spending_limit_cents: Math.round(usd * 100) })}
                      onClear={() => update({ spending_limit_cents: null })}
                    />
                  </label>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{msg("experience.intake.summary.deadline_hours")}</span>
                    <NumberInput
                      size="sm"
                      className="w-24"
                      value={answers.deadline_hours ?? ""}
                      min={1}
                      max={720}
                      step={1}
                      onChange={(hours) => update({ deadline_hours: hours })}
                      onClear={() => update({ deadline_hours: null })}
                    />
                  </label>
                </div>
              </SummaryRow>

              <SummaryRow label={msg("experience.intake.summary.notify")}>
                <NotificationCadenceFields
                  idPrefix="intake-notify"
                  value={answers.notifications}
                  onChange={(patch) =>
                    update({ notifications: { ...answers.notifications, ...patch } })
                  }
                />
              </SummaryRow>
            </section>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border/40 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5">
          {step > 0 ? (
            <Button
              variant="ghost"
              className={TOUCH_TAP}
              onClick={() => setStep((s) => s - 1)}
              disabled={finishing}
            >
              {msg("experience.intake.back")}
            </Button>
          ) : (
            <span />
          )}
          {step < STEPS ? (
            <Button
              className={TOUCH_TAP}
              onClick={() => setStep((s) => s + 1)}
              disabled={!canContinue}
            >
              {msg("experience.intake.next")}
            </Button>
          ) : (
            <Button className={TOUCH_TAP} onClick={() => void finish()} disabled={finishing}>
              {finishing ? msg("experience.intake.finishing") : msg("experience.intake.finish")}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
