"use client";

import { useEffect, useId, useRef, useState } from "react";
import { toast } from "react-toastify";
import { CircleNotch, Info } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import { NumberInput } from "@/shared/ui/number-input";
import type { OptimizationStatusResponse } from "@/shared/types/api";
import { resumeJob, updateExecutionBudget } from "@/shared/lib/api";
import { formatMsg, msg } from "@/shared/lib/messages";
import { TERMS } from "@/shared/lib/terms";
import { formatBlackboxScore, formatPercent } from "@/shared/lib/formatters";
import { formatBudgetAmount } from "@/shared/lib/format-budget-amount";
import { getActiveIntlLocale } from "@/shared/lib/runtime-locale";
import {
  budgetResultKind,
  isBudgetPause,
  isBudgetStop,
  recoveryDisplayState,
  recoveryEpisode,
  type RecoveryDisplayState,
} from "../lib/run-lifecycle";

const RESULT_COPY = {
  evaluated: "optimization.budget_reached.saved",
  seed: "optimization.budget_reached.seed_saved",
  none: "optimization.budget_reached.no_result",
} as const;

const RECOVERY_COPY = {
  recovering: ["optimization.recovery.running_title", "optimization.recovery.running_body"],
  recovered: ["optimization.recovery.recovered_title", "optimization.recovery.recovered_body"],
  unavailable: [
    "optimization.recovery.unavailable_title",
    "optimization.recovery.unavailable_body",
  ],
} as const;

// A projection pause suggests the measured projection plus a margin so one
// raise usually carries the run to the end; a hard stop has no projection, so
// it suggests a step above the limit that was just exhausted.
const PROJECTION_MARGIN = 1.1;
const HARD_STOP_MARGIN = 1.25;

interface RunLifecycleNoticeProps {
  job: OptimizationStatusResponse;
  /** Whether the viewer may raise the limit and continue the run. */
  canEdit?: boolean;
  /** Called after a raise attempt so the owner refetches budget and status. */
  onBudgetChanged?: () => void;
}

/** Keep durable stop/recovery evidence visible after its transition toast closes. */
export function RunLifecycleNotice({
  job,
  canEdit = false,
  onBudgetChanged,
}: RunLifecycleNoticeProps) {
  const budgetStop = isBudgetStop(job);
  const budgetPause = isBudgetPause(job);
  const budget = job.execution_budget ?? job.terminal_evidence?.execution_budget;
  const projection = budgetPause ? (job.terminal_evidence?.budget_projection ?? null) : null;
  const recovery = job.recovery;
  const recoveryState = recoveryDisplayState(recovery);
  const episode = recoveryEpisode(job);
  const previous = useRef<{
    runId: string;
    budgetStop: boolean;
    budgetPause: boolean;
    episode: string | null;
    recoveryState?: RecoveryDisplayState;
  } | null>(null);
  const liveToast = useRef<string | null>(null);
  const resultCopy = msg(RESULT_COPY[budgetResultKind(job)]);
  const [requestedLimit, setRequestedLimit] = useState<number | null>(null);
  const [raising, setRaising] = useState(false);
  const limitInputId = useId();

  useEffect(() => {
    const before = previous.current;
    const sameRun = before?.runId === job.optimization_id;
    const toastId = episode ? `run-recovery:${episode}` : null;
    if (budgetStop) {
      if (liveToast.current) {
        toast.update(liveToast.current, {
          render: `${msg("optimization.budget_reached.title")}. ${resultCopy}`,
          type: "info",
          isLoading: false,
          autoClose: 6000,
        });
        liveToast.current = null;
      } else if (sameRun && !before.budgetStop) {
        toast.info(`${msg("optimization.budget_reached.title")}. ${resultCopy}`, {
          toastId: `run-budget:${job.optimization_id}`,
        });
      }
    } else if (budgetPause) {
      if (liveToast.current) {
        toast.dismiss(liveToast.current);
        liveToast.current = null;
      }
      if (sameRun && !before.budgetPause) {
        toast.info(msg("optimization.budget_projected.title"), {
          toastId: `run-budget-pause:${job.optimization_id}`,
        });
      }
    } else if (recovery && toastId) {
      const changed =
        !sameRun || before?.episode !== episode || before?.recoveryState !== recoveryState;
      const [titleKey, bodyKey] = RECOVERY_COPY[recoveryState];
      const text = `${msg(titleKey)}. ${msg(bodyKey)}`;
      if (changed && recoveryState === "recovering") {
        if (liveToast.current && liveToast.current !== toastId) toast.dismiss(liveToast.current);
        toast.loading(text, { toastId });
        liveToast.current = toastId;
      } else if (changed && liveToast.current === toastId) {
        toast.update(toastId, {
          render: text,
          type: recoveryState === "recovered" ? "success" : "info",
          isLoading: false,
          autoClose: 6000,
        });
        liveToast.current = null;
      }
    } else if (liveToast.current) {
      toast.dismiss(liveToast.current);
      liveToast.current = null;
    }
    previous.current = {
      runId: job.optimization_id,
      budgetStop,
      budgetPause,
      episode,
      recoveryState: recovery ? recoveryState : undefined,
    };
  }, [job.optimization_id, budgetStop, budgetPause, episode, recovery, recoveryState, resultCopy]);

  useEffect(
    () => () => {
      if (liveToast.current) toast.dismiss(liveToast.current);
    },
    [],
  );

  if (!budgetStop && !budgetPause && !recovery && !budget) return null;
  const [titleKey, bodyKey] = recovery ? RECOVERY_COPY[recoveryState] : RECOVERY_COPY.unavailable;
  const budgetHalt = budgetStop || budgetPause;
  const recovering = !budgetHalt && recoveryState === "recovering";
  const evidence = job.terminal_evidence;
  const scope = evidence?.selection_scope;
  const scopeLabel =
    scope === "training"
      ? TERMS.splitTrain
      : scope === "validation"
        ? TERMS.splitVal
        : scope === "test"
          ? TERMS.splitTest
          : msg("optimization.budget_reached.single_task");
  const score = evidence?.selection_score;
  const scoreLabel =
    typeof score === "number" && Number.isFinite(score)
      ? job.optimization_type === "blackbox"
        ? formatBlackboxScore(score)
        : formatPercent(score)
      : null;
  const locale = getActiveIntlLocale();
  const amount = (value: string | number) => formatBudgetAmount(String(value), locale);

  // Continuing needs a limit the run can actually spend under: above the
  // measured projection for a pause, and above what is already committed for
  // a hard stop, or the worker would halt again before its next evaluation.
  const committed = budget
    ? Math.floor(
        Number(budget.setup_spent_credits) +
          Number(budget.run_spent_credits) +
          Number(budget.reserved_credits),
      ) + 1
    : 0;
  const minimumLimit = Math.max(committed, projection ? projection.projected_credits + 1 : 0);
  const suggestedLimit = Math.max(
    minimumLimit,
    projection
      ? Math.ceil(projection.projected_credits * PROJECTION_MARGIN)
      : Math.ceil((budget?.total_credits ?? 0) * HARD_STOP_MARGIN),
  );
  const requested = Math.max(minimumLimit, requestedLimit ?? suggestedLimit);
  const settling = (budget?.pending_operations ?? 0) > 0;
  const canContinue = budgetHalt && canEdit && job.resumable === true && budget != null;

  const handleRaise = async () => {
    if (!budget || raising) return;
    setRaising(true);
    try {
      await updateExecutionBudget(budget.id, requested, budget.revision);
      await resumeJob(job.optimization_id);
      toast.success(msg("optimization.budget_raise.success"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : msg("optimization.budget_raise.failed"));
    } finally {
      setRaising(false);
      // The limit may have changed even when the resume itself failed, so the
      // owner refetches either way and the next attempt carries a fresh revision.
      onBudgetChanged?.();
    }
  };

  return (
    <section
      className="space-y-2 rounded-xl border border-[#C8A882]/45 bg-[#C8A882]/10 p-4"
      role="status"
    >
      <div className="flex items-start gap-2">
        {recovering ? (
          <CircleNotch
            className="mt-0.5 size-4 shrink-0 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
        ) : (
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        )}
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-semibold">
            {budgetStop
              ? msg("optimization.budget_reached.title")
              : budgetPause
                ? msg("optimization.budget_projected.title")
                : recovery
                  ? msg(titleKey)
                  : msg("submit.budget.label")}
          </p>
          {(budgetHalt || recovery) && (
            <p className="text-sm text-muted-foreground" dir="auto">
              {budgetStop
                ? resultCopy
                : budgetPause
                  ? projection
                    ? formatMsg("optimization.budget_projected.body", {
                        done: projection.done_calls,
                        planned: projection.planned_calls,
                        spent: amount(projection.spent_credits),
                        projected: amount(projection.projected_credits),
                        limit: amount(projection.limit_credits),
                      })
                    : msg("optimization.budget_reached.raise_hint")
                  : msg(bodyKey)}
            </p>
          )}
          {budgetStop && job.result_availability === "evaluated" && scope && scoreLabel && (
            <p className="text-xs text-muted-foreground" dir="auto">
              {formatMsg("optimization.budget_reached.selection_score", {
                scope: scopeLabel,
                score: scoreLabel,
              })}
            </p>
          )}
          {budgetStop &&
            evidence?.final_evaluation_reason === "budget_reached" &&
            !evidence.final_evaluation_completed && (
              <p className="text-xs text-muted-foreground">
                {msg("optimization.budget_reached.final_not_run")}
              </p>
            )}
          {budgetStop && canContinue && (
            <p className="text-xs text-muted-foreground">
              {msg("optimization.budget_reached.raise_hint")}
            </p>
          )}
          {!budgetHalt && recovery?.reason && (
            <p className="break-words text-xs text-muted-foreground" dir="auto">
              {recovery.reason}
            </p>
          )}
        </div>
      </div>
      {budget && (
        <div className="space-y-2 border-t border-border/40 pt-3">
          <dl className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-5">
            {(
              [
                ["submit.budget.label", String(budget.total_credits)],
                ["submit.budget.setup_spent", budget.setup_spent_credits],
                ["submit.budget.run_spent", budget.run_spent_credits],
                ["submit.budget.reserved", budget.reserved_credits],
                ["submit.budget.available", budget.available_credits],
              ] as const
            ).map(([key, value]) => (
              <div key={key} className="min-w-0 space-y-1">
                <dt className="text-muted-foreground">{msg(key)}</dt>
                <dd className="break-all font-medium tabular-nums" dir="auto">
                  {amount(value)}
                </dd>
              </div>
            ))}
          </dl>
          {(settling || (budget.blocked_reason && !budgetHalt)) && (
            <p className="text-xs text-muted-foreground">{msg("budget.pending")}</p>
          )}
        </div>
      )}
      {canContinue && budget && (
        <form
          className="flex flex-wrap items-end gap-3 border-t border-border/40 pt-3"
          onSubmit={(event) => {
            event.preventDefault();
            void handleRaise();
          }}
        >
          <div className="space-y-1">
            <label htmlFor={limitInputId} className="block text-xs text-muted-foreground">
              {msg("optimization.budget_raise.label")}
            </label>
            <NumberInput
              id={limitInputId}
              value={requested}
              onChange={setRequestedLimit}
              min={minimumLimit}
              className="w-36"
              disabled={raising || settling}
            />
          </div>
          <Button type="submit" variant="secondary" size="sm" disabled={raising || settling}>
            {raising && (
              <CircleNotch className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
            )}
            {msg("optimization.budget_raise.action")}
          </Button>
          <p className="basis-full text-xs text-muted-foreground" dir="auto">
            {formatMsg("optimization.budget_raise.hint", { min: amount(minimumLimit - 1) })}
          </p>
        </form>
      )}
    </section>
  );
}
