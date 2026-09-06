"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CaretDown, Check, CircleNotch, Clock, Warning } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import { msg } from "@/shared/lib/messages";
import type { MessageKey } from "@/shared/lib/generated/ui-catalog";
import { cn } from "@/shared/lib/utils";
import { getActiveIntlLocale } from "@/shared/lib/runtime-locale";
import type { PreflightScope, WizardPreflightResponse } from "@/shared/types/wizard-preflight";
import { slideVariants } from "../constants";
import { preflightPendingMessageKey } from "../lib/preflight-outcome";
import type {
  PreflightWorkflow,
  ValidationPhase,
  ValidationPhaseProgress,
  ValidationProgress,
  ValidationUsageWait,
} from "../lib/preflight-store";
import { USAGE_WAIT_ATTEMPTS, USAGE_WAIT_INTERVAL_MS } from "../lib/wait-for-preflight-usage";
import { cnGrid } from "./blackbox/shared";

type PreflightCheck = WizardPreflightResponse["checks"][number];

const phaseKeys: Record<ValidationPhase, MessageKey> = {
  budget: "submit.validation.progress.budget",
  dependencies: "submit.validation.progress.dependencies",
  sandbox: "submit.validation.progress.sandbox",
  evaluator: "submit.validation.progress.evaluator",
  models: "submit.validation.progress.models",
  usage: "submit.validation.progress.usage",
};

const detailKeys: Record<ValidationPhase, MessageKey> = {
  budget: "submit.validation.progress.budget_detail",
  dependencies: "submit.validation.progress.dependencies_detail",
  sandbox: "submit.validation.progress.sandbox_detail",
  evaluator: "submit.validation.progress.evaluator_detail",
  models: "submit.validation.progress.models_detail",
  usage: "submit.validation.progress.usage_detail",
};

const checkKeys: Record<string, MessageKey> = {
  program: "submit.validation.check.program",
  metric: "submit.validation.check.metric",
  sample_mapping: "submit.validation.check.sample_mapping",
  sample_prediction: "submit.validation.check.sample_prediction",
  workflow: "submit.validation.check.workflow",
  runtime: "submit.validation.check.runtime",
  usage: "submit.validation.check.usage",
  setup: "submit.validation.check.setup",
  optimizer: "submit.validation.check.optimizer",
  scorer: "submit.validation.check.scorer",
  "scorer.model": "submit.validation.check.scorer.model",
  "scorer.readiness": "submit.validation.check.scorer.readiness",
  "target.readiness": "submit.validation.check.target.readiness",
};

const roleKeys: Record<string, MessageKey> = {
  task: "submit.budget.calc.role.task",
  optimization: "submit.budget.calc.role.optimization",
  judge: "submit.budget.calc.role.judge",
};

const checkStateKeys: Record<PreflightCheck["status"], MessageKey> = {
  succeeded: "submit.validation.progress.state_passed",
  failed: "submit.validation.progress.state_failed",
  pending: "submit.validation.progress.state_pending",
  skipped: "submit.validation.progress.state_skipped",
};

// The steps a check walks through, in order. A step the server skips drops
// out of "up next" as soon as a later one starts.
const PLAN: Record<PreflightWorkflow, Record<PreflightScope, readonly ValidationPhase[]>> = {
  dspy: {
    evaluation: ["budget", "sandbox", "evaluator", "usage"],
    execution: ["budget", "sandbox", "evaluator", "models", "usage"],
  },
  anything: {
    evaluation: ["budget", "dependencies", "sandbox", "evaluator", "usage"],
    execution: ["budget", "dependencies", "sandbox", "evaluator", "models", "usage"],
  },
};

// A passed check moves the wizard on by itself; its result stays just long
// enough to be read before the next step slides in.
const SUCCESS_LINGER_MS = 1200;

// A step that has run this long gets a word of reassurance.
const SLOW_AFTER_MS = 30_000;

type RowTone = "active" | "done" | "failed" | "pending" | "upcoming";

function checkLabel(key: string): string {
  if (key.startsWith("model.")) {
    const role = key.slice("model.".length);
    const roleKey = roleKeys[role];
    return msg("submit.validation.check.model", { role: roleKey ? msg(roleKey) : role });
  }
  const known = checkKeys[key];
  return known ? msg(known) : key;
}

function phaseForCheck(key: string, thrown: ValidationPhase): ValidationPhase {
  if (key.startsWith("model.")) return "models";
  if (key === "usage") return "usage";
  if (key === "runtime") return "sandbox";
  // "setup" is the run itself giving up, wherever it stood at the time.
  if (key === "setup") return thrown;
  return "evaluator";
}

function duration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/**
 * Holds the wizard on its validation while one runs. The stage underneath
 * stays mounted, so editors and dry-run panels keep their state, and comes
 * back once the frame has slid out.
 */
export function ValidationGate({
  validation,
  direction,
  onBack,
  children,
}: {
  validation: ValidationProgress | null;
  direction: number;
  onBack: () => void;
  children: ReactNode;
}) {
  const [stageHidden, setStageHidden] = useState(validation !== null);
  const latest = useRef(validation);
  useLayoutEffect(() => {
    latest.current = validation;
    if (validation) setStageHidden(true);
  }, [validation]);

  return (
    <>
      <AnimatePresence
        mode="wait"
        custom={direction}
        onExitComplete={() => setStageHidden(latest.current !== null)}
      >
        {validation && (
          <motion.div
            key="validation"
            custom={direction}
            variants={slideVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ duration: 0.1 }}
          >
            <ValidationFrame state={validation} onBack={onBack} />
          </motion.div>
        )}
      </AnimatePresence>
      <div hidden={stageHidden}>{children}</div>
    </>
  );
}

export function ValidationFrame({
  state,
  onBack,
}: {
  state: ValidationProgress;
  onBack: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const running = state.status === "running";
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const success = state.status === "succeeded";
  useEffect(() => {
    if (!success) return;
    const timer = setTimeout(onBack, SUCCESS_LINGER_MS);
    return () => clearTimeout(timer);
  }, [success, onBack]);

  const [opened, setOpened] = useState<Record<string, boolean>>({});

  const response = state.response;
  const checks = response?.checks ?? [];
  const failedCheck = checks.find((check) => check.status === "failed");
  // A run the server reports as pending can still carry a failed check (the
  // sandbox never started, say); that is a failure to the reader.
  const failed = state.status === "failed" || (!running && failedCheck !== undefined);
  const phases = state.phases;
  const current = phases[phases.length - 1]?.key ?? "budget";
  const thrown = [...phases].reverse().find((phase) => phase.key !== "usage")?.key ?? current;
  const failedPhase = failed
    ? failedCheck
      ? phaseForCheck(failedCheck.key, thrown)
      : current
    : null;
  const elapsed = duration((state.finishedAt ?? now) - state.startedAt);
  const score = response?.scorer_result?.score ?? undefined;

  // A phase can appear twice (a run resumed after usage settled reports its
  // phases again); a check belongs to the latest row for its phase, and a
  // check whose phase never showed up lands on the last row.
  const rowFor = (phase: ValidationPhase): number => {
    for (let index = phases.length - 1; index >= 0; index -= 1) {
      if (phases[index]!.key === phase) return index;
    }
    return phases.length - 1;
  };
  const checksByRow = new Map<number, PreflightCheck[]>();
  for (const check of checks) {
    const row = rowFor(phaseForCheck(check.key, thrown));
    checksByRow.set(row, [...(checksByRow.get(row) ?? []), check]);
  }
  const brokenRow = failedPhase ? rowFor(failedPhase) : -1;
  const plan = PLAN[state.workflow][state.scope];
  const reached = plan.indexOf(current);
  const upcoming = running && reached >= 0 ? plan.slice(reached + 1) : [];

  const title = running
    ? msg("submit.validation.progress.title")
    : success
      ? msg("submit.validation.progress.success")
      : failed
        ? msg("submit.validation.progress.failed")
        : msg("submit.validation.progress.pending");
  const description = running
    ? msg(detailKeys[current])
    : success
      ? msg("submit.validation.progress.success_detail")
      : failed
        ? (state.message ?? failedCheck?.message ?? msg("submit.preflight.failed"))
        : (state.message ??
          msg(response ? preflightPendingMessageKey(response) : "submit.preflight.incomplete"));

  return (
    <section
      className="overflow-hidden rounded-2xl border border-border/50 bg-card/80 shadow-lg backdrop-blur-xl"
      aria-busy={running}
      data-tutorial="wizard-validation"
    >
      <div className="flex items-start gap-4 px-6 pt-7 pb-6 sm:px-8">
        <div
          className={cn(
            "flex size-12 shrink-0 items-center justify-center rounded-full",
            success
              ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
              : failed
                ? "bg-destructive/10 text-destructive"
                : running
                  ? "bg-muted text-foreground"
                  : "bg-amber-500/10 text-amber-700 dark:text-amber-400",
          )}
          aria-hidden="true"
        >
          {running ? (
            <CircleNotch className="size-6 animate-spin" />
          ) : success ? (
            <Check className="size-6" weight="bold" />
          ) : failed ? (
            <Warning className="size-6" weight="bold" />
          ) : (
            <Clock className="size-6" weight="bold" />
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2 className="text-2xl font-semibold tracking-tight sm:text-[1.75rem]">{title}</h2>
            <span
              className="inline-flex items-center gap-1.5 rounded-full border border-border/60 px-2.5 py-0.5 text-xs tabular-nums text-muted-foreground"
              dir="ltr"
            >
              <Clock className="size-3.5" aria-hidden="true" />
              {elapsed}
            </span>
          </div>
          <p
            className="max-w-prose text-[15px] leading-relaxed text-muted-foreground"
            aria-live="polite"
            dir="auto"
          >
            {description}
          </p>
        </div>
      </div>

      <ol className="divide-y divide-border/60 border-t border-border/60">
        {phases.map((phase, index) => {
          const rowChecks = checksByRow.get(index) ?? [];
          const active = running && index === phases.length - 1;
          const tone: RowTone = active
            ? "active"
            : index === brokenRow
              ? "failed"
              : rowChecks.some((check) => check.status === "pending")
                ? "pending"
                : "done";
          const rowKey = `${phase.key}-${index}`;
          const open = opened[rowKey] ?? (tone === "active" || tone === "failed");
          return (
            <PhaseRow
              key={rowKey}
              id={`validation-${rowKey}`}
              phase={phase}
              tone={tone}
              now={now}
              open={open}
              onToggle={() => setOpened((rows) => ({ ...rows, [rowKey]: !open }))}
              checks={rowChecks}
              score={phase.key === "evaluator" ? score : undefined}
              usage={phase.key === "usage" ? state.usage : undefined}
              message={
                tone === "failed" && rowChecks.every((check) => check.message !== state.message)
                  ? state.message
                  : undefined
              }
            />
          );
        })}
        {upcoming.map((key, offset) => (
          <li
            key={`upcoming-${key}-${offset}`}
            className="flex items-center gap-4 px-6 py-4 sm:px-8"
          >
            <span
              className="flex size-9 shrink-0 items-center justify-center rounded-full border border-dashed border-border text-xs tabular-nums text-muted-foreground"
              aria-hidden="true"
            >
              {phases.length + offset + 1}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-medium text-muted-foreground">
                {msg(phaseKeys[key])}
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground/80">
                {msg("submit.validation.progress.upcoming")}
              </span>
            </span>
          </li>
        ))}
      </ol>

      {!running && !success && (
        <div className="flex flex-col gap-4 border-t border-border/60 bg-muted/30 px-6 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <p className="max-w-72 text-sm leading-relaxed text-muted-foreground">
            {msg("submit.validation.progress.saved")}
          </p>
          <Button className="shrink-0" onClick={onBack}>
            {msg("submit.validation.progress.back")}
          </Button>
        </div>
      )}
    </section>
  );
}

function PhaseRow({
  id,
  phase,
  tone,
  now,
  open,
  onToggle,
  checks,
  score,
  usage,
  message,
}: {
  id: string;
  phase: ValidationPhaseProgress;
  tone: RowTone;
  now: number;
  open: boolean;
  onToggle: () => void;
  checks: PreflightCheck[];
  score: number | undefined;
  usage: ValidationUsageWait | undefined;
  message: string | undefined;
}) {
  const active = tone === "active";
  const elapsedMs = (phase.finishedAt ?? (active ? now : phase.startedAt)) - phase.startedAt;
  const statusWord =
    tone === "failed"
      ? msg("submit.validation.progress.state_failed")
      : tone === "pending"
        ? msg("submit.validation.progress.state_pending")
        : active
          ? msg("submit.validation.progress.working")
          : msg("submit.validation.progress.done");
  const nextCheckIn = usage
    ? Math.max(0, Math.ceil((usage.checkedAt + USAGE_WAIT_INTERVAL_MS - now) / 1000))
    : 0;
  const hasDetail =
    checks.length > 0 || usage !== undefined || score !== undefined || message !== undefined;

  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={id}
        className="flex w-full items-center gap-4 px-6 py-4 text-start transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 sm:px-8"
      >
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-full border",
            tone === "failed"
              ? "border-destructive/40 bg-destructive/10 text-destructive"
              : tone === "pending"
                ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                : tone === "done"
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                  : "border-border bg-background text-foreground",
          )}
          aria-hidden="true"
        >
          {active ? (
            <CircleNotch className="size-4 animate-spin" />
          ) : tone === "failed" ? (
            <Warning className="size-4" weight="bold" />
          ) : tone === "pending" ? (
            <Clock className="size-4" weight="bold" />
          ) : (
            <Check className="size-4" weight="bold" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-medium">{msg(phaseKeys[phase.key])}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">{statusWord}</span>
        </span>
        <span className="text-sm tabular-nums text-muted-foreground" dir="ltr">
          {duration(elapsedMs)}
        </span>
        <CaretDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform duration-200",
            open && "rotate-180",
          )}
          aria-hidden="true"
        />
      </button>
      <div id={id} className={cnGrid(open)} inert={open ? undefined : true}>
        <div className="overflow-hidden">
          <div className="space-y-3 px-6 pb-5 ps-[4.75rem] sm:px-8 sm:ps-[5.25rem]">
            <p className="max-w-prose text-sm text-muted-foreground">
              {msg(detailKeys[phase.key])}
            </p>
            {active && elapsedMs >= SLOW_AFTER_MS && (
              <p className="max-w-prose text-sm text-muted-foreground">
                {msg("submit.validation.progress.slow")}
              </p>
            )}
            {usage && (
              <ul className="space-y-1 text-sm tabular-nums">
                <li>
                  {msg("submit.validation.progress.poll", {
                    count: usage.attempts,
                    limit: USAGE_WAIT_ATTEMPTS,
                  })}
                </li>
                {active && (
                  <li>{msg("submit.validation.progress.next_check", { seconds: nextCheckIn })}</li>
                )}
                <li>
                  {msg("submit.validation.progress.pending_operations", {
                    count: usage.pendingOperations,
                  })}
                </li>
              </ul>
            )}
            {checks.length > 0 && (
              <ul className="space-y-2">
                {checks.map((check) => (
                  <li key={check.key} className="flex items-start gap-2.5 text-sm">
                    <span
                      className={cn(
                        "mt-0.5 flex size-4 shrink-0 items-center justify-center",
                        check.status === "failed"
                          ? "text-destructive"
                          : check.status === "pending"
                            ? "text-amber-700 dark:text-amber-400"
                            : check.status === "skipped"
                              ? "text-muted-foreground"
                              : "text-emerald-700 dark:text-emerald-400",
                      )}
                      aria-hidden="true"
                    >
                      {check.status === "failed" ? (
                        <Warning className="size-4" weight="bold" />
                      ) : check.status === "pending" ? (
                        <Clock className="size-4" weight="bold" />
                      ) : check.status === "skipped" ? (
                        <span className="text-base leading-none">–</span>
                      ) : (
                        <Check className="size-4" weight="bold" />
                      )}
                    </span>
                    <span className="min-w-0">
                      <span className="font-medium">{checkLabel(check.key)}</span>
                      <span className="text-muted-foreground">
                        {" "}
                        · {msg(checkStateKeys[check.status])}
                      </span>
                      {check.message && (
                        <span
                          className="mt-0.5 block max-w-prose break-words text-muted-foreground"
                          dir="auto"
                        >
                          {check.message}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {score !== undefined && (
              <p className="text-sm">
                <span className="text-muted-foreground">
                  {msg("submit.validation.progress.score")}
                </span>
                <span className="font-medium tabular-nums" dir="ltr">
                  {" · "}
                  {score.toLocaleString(getActiveIntlLocale(), { maximumFractionDigits: 4 })}
                </span>
              </p>
            )}
            {message && (
              <p className="max-w-prose break-words text-sm text-destructive" dir="auto">
                {message}
              </p>
            )}
            {!active && !hasDetail && (
              <p className="text-sm text-muted-foreground">
                {msg("submit.validation.progress.no_detail")}
              </p>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}
