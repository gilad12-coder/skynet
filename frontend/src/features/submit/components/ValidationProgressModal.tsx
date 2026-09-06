"use client";

import { useEffect, useState } from "react";
import { Check, CaretDown, Clock, CircleNotch, ArrowRight, Warning } from "@/shared/ui/icons";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/shared/ui/primitives/dialog";
import { Button } from "@/shared/ui/primitives/button";
import { msg } from "@/shared/lib/messages";
import type { MessageKey } from "@/shared/lib/generated/ui-catalog";
import { cn } from "@/shared/lib/utils";
import { formatBudgetAmount } from "@/shared/lib/format-budget-amount";
import { getActiveIntlLocale } from "@/shared/lib/runtime-locale";
import type { WizardPreflightContext } from "../hooks/use-wizard-preflight";
import type { ValidationPhase } from "../hooks/use-validation-progress";

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

function duration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Show execution milestones as they arrive, with the actual result available for inspection. */
export function ValidationProgressModal({ preflight }: { preflight: WizardPreflightContext }) {
  const { state, setOpen } = preflight.progress;
  const [now, setNow] = useState(Date.now);
  const running = state?.status === "running";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  if (!state) return null;
  const success = state.status === "succeeded";
  const failed = state.status === "failed";
  const current = state.phases.at(-1)?.key ?? "budget";
  const elapsed = duration((state.finishedAt ?? now) - state.startedAt);
  const response = state.response;
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
      : (state.message ?? msg("submit.preflight.incomplete"));
  const score = response?.scorer_result?.score;
  const failure = response?.checks.find((check) => check.status === "failed");
  const failedPhase = failure ? phaseForCheck(failure.key) : current;
  return (
    <>
      {!state.open && (
        <Button variant="outline" size="sm" className="gap-2" onClick={() => setOpen(true)}>
          {running ? (
            <CircleNotch className="size-4 motion-safe:animate-spin" />
          ) : success ? (
            <Check className="size-4" />
          ) : (
            <Warning className="size-4" />
          )}
          {msg("submit.validation.progress.view")}
          <span className="tabular-nums text-muted-foreground" dir="ltr">
            {elapsed}
          </span>
        </Button>
      )}
      <Dialog open={state.open} onOpenChange={setOpen}>
        <DialogContent
          showCloseButton={false}
          className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden rounded-2xl border-0 p-0 sm:max-w-xl"
        >
          <div className="shrink-0 px-5 pb-5 pt-6 sm:px-7 sm:pt-7">
            <div className="mb-5 flex items-center justify-between gap-4">
              <div
                className={cn(
                  "flex size-11 items-center justify-center rounded-full",
                  success
                    ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                    : failed
                      ? "bg-destructive/10 text-destructive"
                      : "bg-muted text-foreground",
                )}
              >
                {running ? (
                  <CircleNotch className="size-5 motion-safe:animate-spin" />
                ) : success ? (
                  <Check className="size-5" />
                ) : (
                  <Warning className="size-5" />
                )}
              </div>
              <span className="flex items-center gap-2 text-sm text-muted-foreground">
                <Clock className="size-3.5" />
                <span className="tabular-nums" dir="ltr">
                  {elapsed}
                </span>
              </span>
            </div>
            <DialogTitle className="text-2xl tracking-tight">{title}</DialogTitle>
            <DialogDescription
              className="mt-2 max-h-28 min-h-10 overflow-y-auto break-words text-sm leading-relaxed"
              aria-live="polite"
              dir="auto"
            >
              {description}
            </DialogDescription>
          </div>
          <div className="overflow-y-auto overscroll-contain px-5 pb-6 sm:px-7">
            <ol className="space-y-0" aria-label={msg("submit.validation.progress.title")}>
              {state.phases.map((phase, index) => {
                const active = index === state.phases.length - 1;
                const phaseFailed = failed && phase.key === failedPhase;
                return (
                  <li
                    key={`${phase.key}-${index}`}
                    className="relative flex gap-3 pb-5 last:pb-0"
                    aria-current={active && running ? "step" : undefined}
                  >
                    {index < state.phases.length - 1 && (
                      <span
                        aria-hidden
                        className="absolute start-[13px] top-7 h-[calc(100%-1.5rem)] w-px bg-border"
                      />
                    )}
                    <span
                      className={cn(
                        "relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full border bg-background",
                        active && running
                          ? "border-foreground text-foreground"
                          : phaseFailed
                            ? "border-destructive/40 text-destructive"
                            : "border-border text-muted-foreground",
                      )}
                    >
                      {active && running ? (
                        <CircleNotch className="size-3.5 motion-safe:animate-spin" />
                      ) : phaseFailed || (active && state.status === "pending") ? (
                        <Warning className="size-3.5" />
                      ) : (
                        <Check className="size-3.5" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1 pt-0.5">
                      <div className="flex items-baseline justify-between gap-3">
                        <span
                          className={cn(
                            "text-sm",
                            active ? "font-medium text-foreground" : "text-muted-foreground",
                          )}
                        >
                          {msg(phaseKeys[phase.key])}
                        </span>
                        <span
                          className="shrink-0 text-xs tabular-nums text-muted-foreground"
                          dir="ltr"
                        >
                          {duration(
                            (phase.finishedAt ?? state.finishedAt ?? now) - phase.startedAt,
                          )}
                        </span>
                      </div>
                      <span className="sr-only">
                        {msg(
                          phaseFailed
                            ? "submit.validation.progress.failed"
                            : active && running
                              ? "submit.validation.progress.working"
                              : active && state.status === "pending"
                                ? "submit.validation.progress.pending"
                                : "submit.validation.progress.done",
                        )}
                      </span>
                      {active && running && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {msg("submit.validation.progress.working")}
                        </p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
            {response && (
              <div className="mt-6 border-t pt-4">
                <dl className="flex flex-wrap gap-x-8 gap-y-3 text-sm">
                  {score != null && (
                    <div>
                      <dt className="text-xs text-muted-foreground">
                        {msg("submit.validation.progress.score")}
                      </dt>
                      <dd className="mt-1 font-medium tabular-nums">
                        {new Intl.NumberFormat(getActiveIntlLocale(), {
                          maximumFractionDigits: 4,
                        }).format(score)}
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt className="text-xs text-muted-foreground">
                      {msg("submit.budget.setup_spent")}
                    </dt>
                    <dd className="mt-1 font-medium tabular-nums">
                      {formatBudgetAmount(
                        response.budget.setup_spent_credits,
                        getActiveIntlLocale(),
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">
                      {msg("submit.budget.available")}
                    </dt>
                    <dd className="mt-1 font-medium tabular-nums">
                      {formatBudgetAmount(response.budget.available_credits, getActiveIntlLocale())}
                    </dd>
                  </div>
                </dl>
                <details className="group mt-4">
                  <summary className="flex cursor-pointer items-center justify-between py-2 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    {msg("submit.validation.progress.details")}
                    <CaretDown className="size-4 transition-transform group-open:rotate-180 motion-reduce:transition-none" />
                  </summary>
                  <ul className="mt-2 space-y-3 text-xs">
                    {response.checks.map((check, index) => (
                      <li
                        key={`${check.key}-${index}`}
                        className="flex items-start gap-2 break-words"
                      >
                        {check.status === "succeeded" ? (
                          <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-700 dark:text-emerald-400" />
                        ) : (
                          <Warning className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                        )}
                        <span dir="auto">
                          {check.message ?? msg(phaseKeys[phaseForCheck(check.key)])}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              </div>
            )}
          </div>
          <div className="flex shrink-0 flex-col gap-4 border-t bg-muted/30 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-7">
            <p className="max-w-72 text-xs leading-relaxed text-muted-foreground">
              {running
                ? msg("submit.validation.progress.hide_detail")
                : msg("submit.validation.progress.saved")}
            </p>
            <Button
              variant={running ? "outline" : "default"}
              className="shrink-0 gap-2"
              onClick={() => setOpen(false)}
            >
              {msg(
                running
                  ? "submit.validation.progress.hide"
                  : success
                    ? "submit.validation.progress.done"
                    : "submit.validation.progress.back",
              )}
              {success && <ArrowRight className="size-4 rtl:rotate-180" />}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
