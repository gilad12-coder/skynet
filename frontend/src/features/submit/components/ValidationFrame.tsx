"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, CaretDown, Clock, CircleNotch, Warning } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import { msg } from "@/shared/lib/messages";
import type { MessageKey } from "@/shared/lib/generated/ui-catalog";
import { cn } from "@/shared/lib/utils";
import { formatBudgetAmount } from "@/shared/lib/format-budget-amount";
import { getActiveIntlLocale } from "@/shared/lib/runtime-locale";
import { slideVariants } from "../constants";
import { preflightPendingMessageKey } from "../lib/preflight-outcome";
import type { ValidationPhase, ValidationProgress } from "../lib/preflight-store";

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

function phaseForCheck(key: string): ValidationPhase {
  if (key.startsWith("model.")) return "models";
  if (key === "usage") return "usage";
  if (key === "runtime") return "sandbox";
  return "evaluator";
}

function duration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

// A passed check moves the wizard on by itself; its result stays just long
// enough to be read before the next step slides in.
const SUCCESS_LINGER_MS = 1200;

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

  const failed = state.status === "failed";
  const current = state.phases[state.phases.length - 1]?.key ?? "budget";
  const elapsed = duration((state.finishedAt ?? now) - state.startedAt);
  const response = state.response;
  const failure = response?.checks.find((check) => check.status === "failed");
  const failedPhase = failed ? (failure ? phaseForCheck(failure.key) : current) : null;
  const score = response?.scorer_result?.score;

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
      : (state.message ??
        (failed
          ? (failure?.message ?? msg("submit.preflight.failed"))
          : msg(response ? preflightPendingMessageKey(response) : "submit.preflight.incomplete")));

  return (
    <section
      className="overflow-hidden rounded-2xl border border-border/50 bg-card/80 shadow-lg backdrop-blur-xl"
      aria-busy={running}
      data-tutorial="wizard-validation"
    >
      <div className="flex items-start gap-4 px-5 pt-6 sm:px-7">
        <div
          className={cn(
            "flex size-11 shrink-0 items-center justify-center rounded-full",
            success
              ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
              : failed
                ? "bg-destructive/10 text-destructive"
                : "bg-muted text-foreground",
          )}
          aria-hidden="true"
        >
          {running ? (
            <CircleNotch className="size-5 animate-spin" />
          ) : success ? (
            <Check className="size-5" weight="bold" />
          ) : (
            <Warning className="size-5" weight="bold" />
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
            <span
              className="inline-flex items-center gap-1 text-xs tabular-nums text-muted-foreground"
              dir="ltr"
            >
              <Clock className="size-3.5" aria-hidden="true" />
              {elapsed}
            </span>
          </div>
          <p className="text-sm text-muted-foreground" aria-live="polite" dir="auto">
            {description}
          </p>
        </div>
      </div>

      <ol className="px-5 py-6 sm:px-7">
        {state.phases.map((phase, index) => {
          const active = running && index === state.phases.length - 1;
          const done = phase.finishedAt !== undefined && !(failed && phase.key === failedPhase);
          const broke = failed && phase.key === failedPhase;
          return (
            <li key={`${phase.key}-${index}`} className="relative flex gap-3 pb-5 last:pb-0">
              {index < state.phases.length - 1 && (
                <span
                  className="absolute start-[13px] top-7 h-[calc(100%-1.5rem)] w-px bg-border"
                  aria-hidden="true"
                />
              )}
              <span
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center rounded-full border text-xs",
                  broke
                    ? "border-destructive/40 bg-destructive/10 text-destructive"
                    : done
                      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                      : "border-border bg-background text-muted-foreground",
                )}
                aria-hidden="true"
              >
                {active ? (
                  <CircleNotch className="size-3.5 animate-spin" />
                ) : broke ? (
                  <Warning className="size-3.5" weight="bold" />
                ) : done ? (
                  <Check className="size-3.5" weight="bold" />
                ) : null}
              </span>
              <div className="min-w-0 flex-1 pt-1">
                <div className="flex items-baseline justify-between gap-3">
                  <span
                    className={cn(
                      "text-sm font-medium",
                      !done && !active && !broke && "text-muted-foreground",
                    )}
                  >
                    {msg(phaseKeys[phase.key])}
                  </span>
                  <span className="text-xs tabular-nums text-muted-foreground" dir="ltr">
                    {duration(
                      (phase.finishedAt ?? (active ? now : phase.startedAt)) - phase.startedAt,
                    )}
                  </span>
                </div>
                <span className="sr-only">
                  {broke
                    ? msg("submit.validation.progress.failed")
                    : done
                      ? msg("submit.validation.progress.done")
                      : active
                        ? msg("submit.validation.progress.working")
                        : ""}
                </span>
                {active && (
                  <p className="mt-0.5 text-xs text-muted-foreground" dir="auto">
                    {msg("submit.validation.progress.working")}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {response && (
        <div className="border-t px-5 py-4 sm:px-7">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
            {typeof score === "number" && (
              <div>
                <dt className="text-xs text-muted-foreground">
                  {msg("submit.validation.progress.score")}
                </dt>
                <dd className="font-medium tabular-nums" dir="ltr">
                  {score.toLocaleString(getActiveIntlLocale(), { maximumFractionDigits: 4 })}
                </dd>
              </div>
            )}
            <div>
              <dt className="text-xs text-muted-foreground">{msg("submit.budget.setup_spent")}</dt>
              <dd className="font-medium tabular-nums" dir="ltr">
                {formatBudgetAmount(response.budget.setup_spent_credits, getActiveIntlLocale())}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{msg("submit.budget.available")}</dt>
              <dd className="font-medium tabular-nums" dir="ltr">
                {formatBudgetAmount(response.budget.available_credits, getActiveIntlLocale())}
              </dd>
            </div>
          </dl>
          {response.checks.length > 0 && (
            <details className="group mt-3 text-sm">
              <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-muted-foreground [&::-webkit-details-marker]:hidden">
                <CaretDown
                  className="size-3.5 transition-transform group-open:rotate-180"
                  aria-hidden="true"
                />
                {msg("submit.validation.progress.details")}
              </summary>
              <ul className="mt-2 space-y-1.5">
                {response.checks.map((check) => (
                  <li key={check.key} className="flex items-start gap-2 text-xs">
                    <span
                      className={cn(
                        "mt-0.5 size-1.5 shrink-0 rounded-full",
                        check.status === "failed"
                          ? "bg-destructive"
                          : check.status === "pending"
                            ? "bg-amber-500"
                            : "bg-emerald-500",
                      )}
                      aria-hidden="true"
                    />
                    <span dir="auto">
                      <span className="font-medium">
                        {msg(phaseKeys[phaseForCheck(check.key)])}
                      </span>
                      {check.message ? `: ${check.message}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {!running && !success && (
        <div className="flex flex-col gap-4 border-t bg-muted/30 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-7">
          <p className="max-w-72 text-xs leading-relaxed text-muted-foreground">
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
