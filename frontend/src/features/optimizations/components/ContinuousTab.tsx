"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "react-toastify";
import {
  ArrowClockwise,
  ArrowRight,
  ArrowSquareOut,
  Check,
  Info,
  PencilSimple,
  Repeat,
  Trash,
  X,
} from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import { Card, CardContent } from "@/shared/ui/primitives/card";
import { Input } from "@/shared/ui/primitives/input";
import { Label } from "@/shared/ui/primitives/label";
import { Switch } from "@/shared/ui/primitives/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/primitives/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/primitives/select";
import { EmptyState } from "@/shared/ui/empty-state";
import { ProgressBar } from "@/shared/ui/progress-bar";
import { Skeleton } from "@/shared/ui/skeleton";
import { formatMsg, msg, type MessageKey } from "@/shared/lib/messages";
import { tI18n } from "@/shared/lib/i18n";
import { getActiveIntlLocale } from "@/shared/lib/runtime-locale";
import {
  checkContinuousNow,
  deleteContinuous,
  enableContinuous,
  getContinuousState,
  reviewContinuousCycle,
  setContinuousPaused,
  stageContinuousInputs,
  updateContinuousSchedule,
  type ConnectorProvider,
} from "@/shared/lib/api";
import { formatCentsUsd } from "@/features/billing";
import { providerMeta, useConnectors } from "@/features/connectors";
import type {
  ContinuousCycle,
  ContinuousPermitted,
  ContinuousPlan,
  ContinuousState,
  ScheduleRule,
} from "@/shared/types/continuous";
import { cn } from "@/shared/lib/utils";
import {
  allowanceShare,
  canReview,
  cycleTone,
  enableProblem,
  refreshDelayMs,
  type CycleTone,
} from "../lib/continuous";
import { browserTimeZone, defaultRule, scheduleProblem } from "../lib/continuous-schedule";
import { ScheduleEditor, describeSchedule, formatCheck } from "./ScheduleEditor";
import { ScheduledRunSetup } from "./ScheduledRunSetup";

const STATUS_KEYS: Record<ContinuousCycle["status"], MessageKey> = {
  checking: "continuous_tab.cycle.checking",
  skipped: "continuous_tab.cycle.skipped",
  failed: "continuous_tab.cycle.failed",
  paused: "continuous_tab.cycle.paused",
  optimizing: "continuous_tab.cycle.optimizing",
  regressed: "continuous_tab.cycle.regressed",
  awaiting_review: "continuous_tab.cycle.awaiting_review",
  approved: "continuous_tab.cycle.approved",
  rejected: "continuous_tab.cycle.rejected",
};

const TONE_CLASS: Record<CycleTone, string> = {
  good: "border-[var(--success-border)] bg-[var(--success-dim)] text-[var(--success)]",
  warn: "border-[var(--warning-border)] bg-[var(--warning-dim)] text-[var(--warning)]",
  bad: "border-[var(--danger-border)] bg-[var(--danger-dim)] text-[var(--danger)]",
  muted: "border-border/60 bg-muted text-muted-foreground",
  busy: "border-primary/30 bg-primary/10 text-primary",
};

const PAUSE_KEYS: Partial<Record<NonNullable<ContinuousPlan["pause_reason"]>, MessageKey>> = {
  user: "continuous_tab.paused.user",
  allowance: "continuous_tab.paused.allowance",
  funds: "continuous_tab.paused.funds",
  failing: "continuous_tab.paused.failing",
};

const CHANGE_KEYS: Record<string, MessageKey> = {
  data: "continuous_tab.permit.data",
  models: "continuous_tab.permit.models",
  optimizers: "continuous_tab.permit.optimizers",
};

type Act = (run: () => Promise<ContinuousPlan>, success?: MessageKey) => Promise<void>;
type Remove = () => Promise<void>;

function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(getActiveIntlLocale(), {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatScore(score: number | null): string {
  return score == null ? "—" : score.toFixed(3);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : msg("continuous_tab.action_failed");
}

/**
 * Continuous optimization of a successful run: enable a plan, see the next
 * check and this month's allowance, pause or resume it, and review each
 * cycle. A check with no permitted change is shown as skipped and has no
 * rerun. A candidate becomes the incumbent only when the owner approves it.
 */
export function ContinuousTab({ optimizationId }: { optimizationId: string }) {
  const [state, setState] = useState<ContinuousState | null>(null);
  const [turnedOn, setTurnedOn] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getContinuousState(optimizationId)
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [optimizationId]);

  useEffect(() => {
    const delay = state?.plan ? refreshDelayMs(state.plan, Date.now()) : null;
    if (delay === null) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      getContinuousState(optimizationId)
        .then((next) => {
          if (!cancelled) setState(next);
        })
        // A failed refresh keeps what is shown and, as a new state, schedules the next try.
        .catch(() => {
          if (!cancelled) setState((prev) => (prev ? { ...prev } : prev));
        });
    }, delay);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [state, optimizationId]);

  const act: Act = async (run, success) => {
    setBusy(true);
    try {
      const plan = await run();
      if (success) toast.success(msg(success));
      // A new plan flags its runs as automations in the sidebar.
      if (!state?.plan) window.dispatchEvent(new Event("optimizations-changed"));
      setState({ plan, eligible: true });
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const remove: Remove = async () => {
    if (!state?.plan) return;
    setBusy(true);
    try {
      await deleteContinuous(state.plan.id);
      toast.success(msg("continuous_tab.toast.deleted"));
      window.dispatchEvent(new Event("optimizations-changed"));
      setTurnedOn(false);
      setState(await getContinuousState(optimizationId));
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (loadError) return <EmptyState icon={Repeat} title={msg("continuous_tab.load_error")} />;
  if (!state) {
    return (
      <div className="mt-4 space-y-3" aria-busy="true">
        <Skeleton height={96} containerClassName="block w-full" />
        <Skeleton height={160} containerClassName="block w-full" />
      </div>
    );
  }
  if (!state.plan) {
    if (!state.eligible) {
      const noTestSplit = state.held_out === false;
      return (
        <EmptyState
          icon={Repeat}
          title={msg(noTestSplit ? "continuous_tab.no_test_split.title" : "continuous_tab.not_eligible.title")}
          description={msg(
            noTestSplit ? "continuous_tab.no_test_split.description" : "continuous_tab.not_eligible.description",
          )}
        />
      );
    }
    return (
      <Card className="mt-4 overflow-hidden py-0">
        <CardContent className="divide-y divide-border/50 p-0">
          <div className="flex items-center justify-between gap-4 p-5 sm:p-6">
            <div className="flex min-w-0 items-center gap-1.5">
              <StatusLabel tone="muted">
                {msg(turnedOn ? "continuous_tab.status.setup" : "continuous_tab.status.off")}
              </StatusLabel>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={msg(
                      turnedOn ? "continuous_tab.setup_hint" : "continuous_tab.off_hint",
                    )}
                  >
                    <Info className="size-4" aria-hidden="true" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-none whitespace-nowrap">
                  {msg(turnedOn ? "continuous_tab.setup_hint" : "continuous_tab.off_hint")}
                </TooltipContent>
              </Tooltip>
            </div>
            <Switch
              checked={turnedOn}
              disabled={busy}
              onCheckedChange={setTurnedOn}
              aria-label={msg("continuous_tab.toggle")}
            />
          </div>
          {turnedOn && (
            <ScheduledRunSetup
              busy={busy}
              idPrefix="continuous-schedule"
              finishLabel="continuous_tab.walk.start"
              onFinish={(body) =>
                act(() => enableContinuous(optimizationId, body), "continuous_tab.toast.enabled")
              }
            />
          )}
        </CardContent>
      </Card>
    );
  }
  if (state.plan.status === "waiting" || state.plan.status === "ended") {
    return <NotStartedView plan={state.plan} busy={busy} remove={remove} />;
  }
  return <PlanView plan={state.plan} busy={busy} act={act} remove={remove} />;
}

function StatusLabel({
  tone,
  children,
}: {
  tone: "success" | "muted";
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-sm font-medium",
        tone === "success" ? "text-[var(--success)]" : "text-muted-foreground",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full",
          tone === "success" ? "bg-[var(--success)]" : "bg-muted-foreground",
        )}
      />
      {children}
    </span>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  // The global h3 size is unlayered and outranks a plain utility, so the size is forced here.
  return <h3 className="text-sm! leading-6! font-semibold">{children}</h3>;
}

/**
 * A plan set up in the submit wizard before its first run finished: it
 * waits for that run, or ended because the run did not succeed.
 */
function NotStartedView({
  plan,
  busy,
  remove,
}: {
  plan: ContinuousPlan;
  busy: boolean;
  remove: Remove;
}) {
  const ended = plan.status === "ended";
  return (
    <Card className="mt-4 overflow-hidden py-0">
      <CardContent className="divide-y divide-border/50 p-0">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4 p-5 sm:p-6">
          <div className="min-w-0 space-y-1">
            <StatusLabel tone="muted">
              {msg(ended ? "continuous_tab.status.ended" : "continuous_tab.status.waiting")}
            </StatusLabel>
            <p className="max-w-prose text-lg font-semibold">
              {msg(
                !ended
                  ? "continuous_tab.waiting.description"
                  : plan.pause_reason === "no_test_split"
                    ? "continuous_tab.no_test_split.description"
                    : "continuous_tab.ended.description",
              )}
            </p>
          </div>
          <DeleteButton busy={busy} remove={remove} />
        </div>
        <dl>
          <SettingRow label={msg("continuous_tab.schedule.label")}>
            <p className="text-sm font-medium">{describeSchedule(plan.schedule)}</p>
          </SettingRow>
        </dl>
      </CardContent>
    </Card>
  );
}

/** Deletes the plan after a second click, so one stray click keeps it. */
function DeleteButton({ busy, remove }: { busy: boolean; remove: Remove }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(true)}>
        <Trash className="size-4" aria-hidden />
        {msg("continuous_tab.delete")}
      </Button>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="destructive" size="sm" disabled={busy} onClick={() => void remove()}>
        <Trash className="size-4" aria-hidden />
        {msg("continuous_tab.delete.confirm")}
      </Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(false)}>
        {msg("continuous_tab.schedule.cancel")}
      </Button>
    </div>
  );
}

function PlanView({
  plan,
  busy,
  act,
  remove,
}: {
  plan: ContinuousPlan;
  busy: boolean;
  act: Act;
  remove: Remove;
}) {
  const locale = getActiveIntlLocale();
  const paused = plan.status === "paused";
  const { usage } = plan;
  const [editing, setEditing] = useState<ScheduleRule | null>(null);
  const checkRunning = plan.cycles.some(
    (c) => c.status === "checking" || c.status === "optimizing",
  );
  const pending = plan.cycles.filter(canReview);
  const refreshes = (["data", "models", "optimizers"] as const).filter((key) => plan.permitted[key]);
  const staged = plan.permitted.models || plan.permitted.optimizers;
  return (
    <Card className="mt-4 overflow-hidden py-0">
      <CardContent className="divide-y divide-border/50 p-0">
          {pending.map((cycle) => (
            <ReviewCard key={cycle.id} plan={plan} cycle={cycle} busy={busy} act={act} />
          ))}

          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4 p-5 sm:p-6">
            <div className="min-w-0">
              {paused && plan.pause_reason && PAUSE_KEYS[plan.pause_reason] ? (
                <p className="max-w-prose text-lg font-semibold">
                  {msg(PAUSE_KEYS[plan.pause_reason]!)}
                </p>
              ) : (
                <p className="text-lg font-semibold tracking-tight tabular-nums">
                  {formatMsg("continuous_tab.next_check_on", { when: formatWhen(plan.next_check_at) })}
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <Button
                variant="outline"
                size="sm"
                disabled={busy || paused || checkRunning}
                title={msg(
                  paused
                    ? "continuous_tab.check_now.paused"
                    : checkRunning
                      ? "continuous_tab.check_now.busy"
                      : "continuous_tab.check_now.help",
                )}
                onClick={() => act(() => checkContinuousNow(plan.id), "continuous_tab.check_now.started")}
              >
                <ArrowClockwise className="size-4" />
                {msg("continuous_tab.check_now")}
              </Button>
              <label className="flex cursor-pointer items-center gap-2.5 rounded-full border border-border/70 py-1 ps-3 pe-1">
                <StatusLabel tone={paused ? "muted" : "success"}>
                  {msg(paused ? "continuous_tab.status.paused" : "continuous_tab.status.active")}
                </StatusLabel>
                <Switch
                  checked={!paused}
                  disabled={busy}
                  onCheckedChange={(on) =>
                    act(
                      () => setContinuousPaused(plan.id, !on),
                      on ? "continuous_tab.toast.resumed" : "continuous_tab.toast.paused",
                    )
                  }
                  aria-label={msg("continuous_tab.toggle")}
                />
              </label>
            </div>
          </div>

          <dl className="divide-y divide-border/50">
            <SettingRow
              label={msg("continuous_tab.schedule.label")}
              action={
                editing === null && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={busy}
                        onClick={() => setEditing(plan.schedule)}
                        aria-label={msg("continuous_tab.schedule.edit")}
                      >
                        <PencilSimple className="size-4" aria-hidden />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{msg("continuous_tab.schedule.edit")}</TooltipContent>
                  </Tooltip>
                )
              }
            >
              {editing === null ? (
                <div className="space-y-3">
                  <p className="text-sm font-medium">{describeSchedule(plan.schedule)}</p>
                  {plan.upcoming_checks.length > 0 && (
                    <ul className="flex flex-wrap gap-2" aria-label={msg("continuous_tab.schedule.next_checks")}>
                      {plan.upcoming_checks.map((iso) => (
                        <CheckTile key={iso} iso={iso} timezone={plan.schedule.timezone} />
                      ))}
                    </ul>
                  )}
                </div>
              ) : (
                <div className="space-y-4">
                  <ScheduleEditor value={editing} onChange={setEditing} idPrefix="continuous-edit" />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      disabled={busy || scheduleProblem(editing) != null}
                      onClick={() =>
                        act(async () => {
                          const next = await updateContinuousSchedule(plan.id, editing);
                          setEditing(null);
                          return next;
                        }, "continuous_tab.toast.schedule_saved")
                      }
                    >
                      {msg("continuous_tab.schedule.save")}
                    </Button>
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => setEditing(null)}>
                      {msg("continuous_tab.schedule.cancel")}
                    </Button>
                  </div>
                </div>
              )}
            </SettingRow>

            <SettingRow label={msg("continuous_tab.refreshes_label")}>
              <p className="text-sm font-medium">
                {refreshes.map((key) => msg(CHANGE_KEYS[key]!)).join(", ")}
              </p>
            </SettingRow>

            {staged && (
              <SettingRow
                label={msg("continuous_tab.stage.title")}
                hint={msg("continuous_tab.stage.description")}
              >
                <StageInputs plan={plan} busy={busy} act={act} />
              </SettingRow>
            )}

            <SettingRow label={msg("continuous_tab.version_label")}>
              <Link
                className="inline-flex items-center gap-1 text-sm font-medium underline-offset-4 hover:underline"
                href={`/optimizations/${plan.incumbent_optimization_id}`}
              >
                <bdi className="font-mono text-[0.8125rem]">
                  {plan.incumbent_optimization_id.slice(0, 8)}
                </bdi>
                <ArrowSquareOut className="size-3 text-muted-foreground rtl:-scale-x-100" />
              </Link>
            </SettingRow>

            {usage.limit_cents != null && (
              <SettingRow label={msg("continuous_tab.allowance_label")}>
                <div className="space-y-1.5">
                  <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                    <span>
                      {formatMsg("continuous_tab.allowance", {
                        used: formatCentsUsd(usage.committed_cents, locale),
                        limit: formatCentsUsd(usage.limit_cents ?? 0, locale),
                      })}
                    </span>
                    <span>
                      {formatMsg("continuous_tab.allowance_resets", {
                        when: formatWhen(usage.resets_at),
                      })}
                    </span>
                  </div>
                  <ProgressBar value={allowanceShare(usage) * 100} />
                </div>
              </SettingRow>
            )}
          </dl>

          <section className="bg-muted/30">
            <div className="px-5 pt-5 sm:px-6">
              <SectionTitle>{msg("continuous_tab.history")}</SectionTitle>
            </div>
            {plan.cycles.length === 0 ? (
              <p className="px-5 pt-2 pb-5 text-sm text-muted-foreground sm:px-6">
                {msg("continuous_tab.history_empty")}
              </p>
            ) : (
              <ol className="divide-y divide-border/50 pt-1">
                {plan.cycles.map((cycle) => (
                  <CycleRow key={cycle.id} cycle={cycle} />
                ))}
              </ol>
            )}
          </section>

          <div className="flex justify-end px-5 py-3 sm:px-6">
            <DeleteButton busy={busy} remove={remove} />
          </div>
      </CardContent>
    </Card>
  );
}

function SettingRow({
  label,
  hint,
  action,
  children,
}: {
  label: string;
  hint?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-x-8 gap-y-2 px-5 py-4 sm:px-6 lg:grid-cols-[13rem_minmax(0,1fr)_auto]">
      <dt className="space-y-0.5">
        <span className="text-sm text-muted-foreground">{label}</span>
        {hint && <p className="text-xs text-muted-foreground/80">{hint}</p>}
      </dt>
      <dd className="min-w-0">{children}</dd>
      {action && <div className="-my-1 lg:justify-self-end">{action}</div>}
    </div>
  );
}

/** One upcoming check as a small date tile, read in the plan's zone. */
function CheckTile({ iso, timezone }: { iso: string; timezone: string }) {
  const locale = getActiveIntlLocale();
  const at = new Date(iso);
  const part = (opts: Intl.DateTimeFormatOptions) =>
    at.toLocaleString(locale, { ...opts, timeZone: timezone });
  return (
    <li
      title={formatCheck(iso, timezone)}
      className="flex items-center gap-2.5 rounded-lg border border-border/60 bg-muted/40 py-1.5 ps-1.5 pe-3"
    >
      <span className="flex size-9 flex-col items-center justify-center rounded-md bg-background leading-none shadow-xs">
        <span className="text-[0.625rem] font-medium uppercase text-primary">{part({ month: "short" })}</span>
        <span className="text-sm font-semibold tabular-nums">{part({ day: "numeric" })}</span>
      </span>
      <span className="text-xs leading-tight">
        <span className="block font-medium">{part({ weekday: "short" })}</span>
        <span className="block text-muted-foreground tabular-nums">
          {part({ hour: "numeric", minute: "2-digit" })}
        </span>
      </span>
    </li>
  );
}

function ReviewCard({
  plan,
  cycle,
  busy,
  act,
}: {
  plan: ContinuousPlan;
  cycle: ContinuousCycle;
  busy: boolean;
  act: Act;
}) {
  const locale = getActiveIntlLocale();
  const gain =
    cycle.incumbent_score != null && cycle.candidate_score != null
      ? cycle.candidate_score - cycle.incumbent_score
      : null;
  return (
    <div className="flex flex-wrap items-end justify-between gap-5 border-s-2 border-s-primary bg-primary/[0.05] p-5 sm:p-6">
        <div className="min-w-0 space-y-3">
          <div className="space-y-0.5">
            <SectionTitle>{msg("continuous_tab.review.title")}</SectionTitle>
            <p className="text-xs text-muted-foreground">
              {formatWhen(cycle.created_at)}
              {cycle.changes.length > 0 &&
                ` · ${formatMsg("continuous_tab.changed", {
                  changes: cycle.changes
                    .map((c) => (CHANGE_KEYS[c] ? msg(CHANGE_KEYS[c]) : c))
                    .join(", "),
                })}`}
              {cycle.spent_cents != null &&
                cycle.spent_cents > 0 &&
                ` · ${formatMsg("continuous_tab.spent", {
                  amount: formatCentsUsd(cycle.spent_cents, locale),
                })}`}
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-x-6 gap-y-2 tabular-nums">
            <div>
              <p className="text-xs text-muted-foreground">{msg("continuous_tab.review.current")}</p>
              <p className="text-xl font-medium text-muted-foreground">
                {formatScore(cycle.incumbent_score)}
              </p>
            </div>
            <ArrowRight aria-hidden className="mb-1.5 size-4 text-muted-foreground rtl:-scale-x-100" />
            <div>
              <p className="text-xs text-muted-foreground">{msg("continuous_tab.review.new")}</p>
              <p className="text-xl font-semibold">
                {formatScore(cycle.candidate_score)}
                {gain != null && gain > 0 && (
                  <span className="ms-2 text-sm font-medium text-[var(--success)]">
                    +{gain.toFixed(3)}
                  </span>
                )}
              </p>
            </div>
            {cycle.optimization_id && (
              <Link
                className="mb-1 inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline"
                href={`/optimizations/${cycle.optimization_id}`}
              >
                {msg("continuous_tab.open_run")}
                <ArrowSquareOut className="size-3 rtl:-scale-x-100" />
              </Link>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              act(() => reviewContinuousCycle(plan.id, cycle.id, false), "continuous_tab.toast.rejected")
            }
          >
            <X className="size-4" />
            {msg("continuous_tab.reject")}
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              act(() => reviewContinuousCycle(plan.id, cycle.id, true), "continuous_tab.toast.approved")
            }
          >
            <Check className="size-4" />
            {msg("continuous_tab.approve")}
          </Button>
        </div>
    </div>
  );
}

function StageInputs({
  plan,
  busy,
  act,
}: {
  plan: ContinuousPlan;
  busy: boolean;
  act: Act;
}) {
  const [taskModel, setTaskModel] = useState(plan.pending_inputs.task_model ?? "");
  const [optimizer, setOptimizer] = useState(plan.pending_inputs.optimizer ?? "");
  const body = {
    ...(plan.permitted.models && taskModel.trim() ? { task_model: taskModel.trim() } : {}),
    ...(plan.permitted.optimizers && optimizer.trim() ? { optimizer: optimizer.trim() } : {}),
  };
  return (
    <div className="flex flex-wrap items-end gap-3">
      {plan.permitted.models && (
        <div className="min-w-56 flex-1 space-y-1.5 sm:max-w-sm">
          <Label htmlFor="continuous-task-model">{msg("continuous_tab.stage.task_model")}</Label>
          <Input
            id="continuous-task-model"
            dir="ltr"
            value={taskModel}
            onChange={(e) => setTaskModel(e.target.value)}
          />
        </div>
      )}
      {plan.permitted.optimizers && (
        <div className="min-w-56 flex-1 space-y-1.5 sm:max-w-sm">
          <Label htmlFor="continuous-optimizer">{msg("continuous_tab.stage.optimizer")}</Label>
          <Input
            id="continuous-optimizer"
            dir="ltr"
            value={optimizer}
            onChange={(e) => setOptimizer(e.target.value)}
          />
        </div>
      )}
      <Button
        variant="outline"
        disabled={busy || Object.keys(body).length === 0}
        onClick={() =>
          act(() => stageContinuousInputs(plan.id, body), "continuous_tab.toast.inputs_saved")
        }
      >
        {msg("continuous_tab.stage.submit")}
      </Button>
    </div>
  );
}

function CycleRow({ cycle }: { cycle: ContinuousCycle }) {
  const locale = getActiveIntlLocale();
  const scored = cycle.incumbent_score != null && cycle.candidate_score != null;
  return (
    <li className="grid gap-x-6 gap-y-1.5 px-5 py-4 sm:grid-cols-[13rem_minmax(0,1fr)] sm:gap-x-8 sm:px-6">
      <div className="flex items-center gap-2 sm:flex-col sm:items-start sm:gap-1.5">
        <span
          className={cn(
            "w-fit rounded-full border px-2 py-0.5 text-xs font-medium",
            TONE_CLASS[cycleTone(cycle.status)],
          )}
        >
          {msg(STATUS_KEYS[cycle.status] ?? "continuous_tab.cycle.checking")}
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatWhen(cycle.created_at)}
        </span>
      </div>
      <div className="min-w-0 space-y-1">
        {cycle.detail_code && <p className="text-sm">{tI18n(cycle.detail_code, cycle.detail_params)}</p>}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {cycle.changes.length > 0 && (
            <span>
              {formatMsg("continuous_tab.changed", {
                changes: cycle.changes
                  .map((c) => (CHANGE_KEYS[c] ? msg(CHANGE_KEYS[c]) : c))
                  .join(", "),
              })}
            </span>
          )}
          {scored && (
            <span className="tabular-nums">
              {formatMsg("continuous_tab.scores", {
                incumbent: formatScore(cycle.incumbent_score),
                candidate: formatScore(cycle.candidate_score),
              })}
            </span>
          )}
          {cycle.spent_cents != null && cycle.spent_cents > 0 && (
            <span>
              {formatMsg("continuous_tab.spent", {
                amount: formatCentsUsd(cycle.spent_cents, locale),
              })}
            </span>
          )}
          {cycle.optimization_id && (
            <Link
              className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
              href={`/optimizations/${cycle.optimization_id}`}
            >
              {msg("continuous_tab.open_run")}
              <ArrowSquareOut className="size-3 rtl:-scale-x-100" />
            </Link>
          )}
        </div>
      </div>
    </li>
  );
}
