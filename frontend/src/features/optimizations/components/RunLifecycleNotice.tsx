"use client";

import { useEffect, useRef } from "react";
import { toast } from "react-toastify";
import { CircleNotch, Info } from "@/shared/ui/icons";
import type { OptimizationStatusResponse } from "@/shared/types/api";
import { formatMsg, msg } from "@/shared/lib/messages";
import { TERMS } from "@/shared/lib/terms";
import { formatBlackboxScore, formatPercent } from "@/shared/lib/formatters";
import { formatBudgetAmount } from "@/shared/lib/format-budget-amount";
import { getActiveIntlLocale } from "@/shared/lib/runtime-locale";
import {
  budgetResultKind,
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

/** Keep durable stop/recovery evidence visible after its transition toast closes. */
export function RunLifecycleNotice({ job }: { job: OptimizationStatusResponse }) {
  const budgetStop = isBudgetStop(job);
  const budget = job.execution_budget ?? job.terminal_evidence?.execution_budget;
  const recovery = job.recovery;
  const recoveryState = recoveryDisplayState(recovery);
  const episode = recoveryEpisode(job);
  const previous = useRef<{
    runId: string;
    budgetStop: boolean;
    episode: string | null;
    recoveryState?: RecoveryDisplayState;
  } | null>(null);
  const liveToast = useRef<string | null>(null);
  const resultCopy = msg(RESULT_COPY[budgetResultKind(job)]);

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
    } else if (recovery && toastId) {
      const changed = !sameRun || before?.episode !== episode || before?.recoveryState !== recoveryState;
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
      episode,
      recoveryState: recovery ? recoveryState : undefined,
    };
  }, [job.optimization_id, budgetStop, episode, recovery, recoveryState, resultCopy]);

  useEffect(
    () => () => {
      if (liveToast.current) toast.dismiss(liveToast.current);
    },
    [],
  );

  if (!budgetStop && !recovery && !budget) return null;
  const [titleKey, bodyKey] = recovery ? RECOVERY_COPY[recoveryState] : RECOVERY_COPY.unavailable;
  const recovering = !budgetStop && recoveryState === "recovering";
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
              : recovery
                ? msg(titleKey)
                : msg("submit.budget.label")}
          </p>
          {(budgetStop || recovery) && (
            <p className="text-sm text-muted-foreground">
              {budgetStop ? resultCopy : msg(bodyKey)}
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
          {!budgetStop && recovery?.reason && (
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
            ).map(([key, amount]) => (
              <div key={key} className="min-w-0 space-y-1">
                <dt className="text-muted-foreground">{msg(key)}</dt>
                <dd className="break-all font-medium tabular-nums" dir="auto">
                  {formatBudgetAmount(amount, getActiveIntlLocale())}
                </dd>
              </div>
            ))}
          </dl>
          {(budget.pending_operations > 0 || budget.blocked_reason) && (
            <p className="text-xs text-muted-foreground">{msg("budget.pending")}</p>
          )}
        </div>
      )}
    </section>
  );
}
