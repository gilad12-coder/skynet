"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "react-toastify";
import {
  ArrowClockwise,
  ArrowSquareOut,
  Check,
  PencilSimple,
  Pause,
  Play,
  Repeat,
  X,
} from "@/shared/ui/icons";
import { Badge } from "@/shared/ui/primitives/badge";
import { Button } from "@/shared/ui/primitives/button";
import { Card, CardContent } from "@/shared/ui/primitives/card";
import { Input } from "@/shared/ui/primitives/input";
import { Label } from "@/shared/ui/primitives/label";
import { Switch } from "@/shared/ui/primitives/switch";
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
  usdTextToCents,
  type CycleTone,
} from "../lib/continuous";
import { browserTimeZone, defaultRule, scheduleProblem } from "../lib/continuous-schedule";
import { ScheduleEditor, describeSchedule, formatCheck } from "./ScheduleEditor";

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

const PAUSE_KEYS: Record<NonNullable<ContinuousPlan["pause_reason"]>, MessageKey> = {
  user: "continuous_tab.paused.user",
  allowance: "continuous_tab.paused.allowance",
  funds: "continuous_tab.paused.funds",
};

const CHANGE_KEYS: Record<string, MessageKey> = {
  data: "continuous_tab.permit.data",
  models: "continuous_tab.permit.models",
  optimizers: "continuous_tab.permit.optimizers",
};

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

  const act = async (run: () => Promise<ContinuousPlan>) => {
    setBusy(true);
    try {
      const plan = await run();
      // A new plan flags its runs as automations in the sidebar.
      if (!state?.plan) window.dispatchEvent(new Event("optimizations-changed"));
      setState({ plan, eligible: true });
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
      return (
        <EmptyState
          icon={Repeat}
          title={msg("continuous_tab.not_eligible.title")}
          description={msg("continuous_tab.not_eligible.description")}
        />
      );
    }
    return (
      <EnableForm
        busy={busy}
        onEnable={(body) => act(() => enableContinuous(optimizationId, body))}
      />
    );
  }
  return <PlanView plan={state.plan} busy={busy} act={act} />;
}

function EnableForm({
  busy,
  onEnable,
}: {
  busy: boolean;
  onEnable: (body: Parameters<typeof enableContinuous>[1]) => void;
}) {
  const { connectors } = useConnectors();
  const connected = connectors.filter((c) => c.connected);
  const [schedule, setSchedule] = useState<ScheduleRule>(() => defaultRule(browserTimeZone()));
  const [permitted, setPermitted] = useState<ContinuousPermitted>({
    data: true,
    models: false,
    optimizers: false,
  });
  const [provider, setProvider] = useState<string>("");
  const [sourceRef, setSourceRef] = useState("");
  const [monthlyLimit, setMonthlyLimit] = useState("10");
  const [cycleBudget, setCycleBudget] = useState("2");
  const chosenProvider = provider || connected[0]?.provider || "";
  const problem =
    scheduleProblem(schedule) ??
    enableProblem({
      permitted,
      sourceRef: chosenProvider ? sourceRef : "",
      monthlyLimit,
      cycleBudget,
    });

  const toggle = (key: keyof ContinuousPermitted) => (on: boolean) =>
    setPermitted((prev) => ({ ...prev, [key]: on }));

  return (
    <Card className="mt-4">
      <CardContent className="space-y-5 p-5">
        <div className="space-y-1">
          <h3 className="text-base font-semibold">{msg("continuous_tab.enable.title")}</h3>
          <p className="text-sm text-muted-foreground">
            {msg("continuous_tab.enable.description")}
          </p>
        </div>

        <div className="space-y-2">
          <span className="text-sm font-medium">{msg("continuous_tab.schedule.label")}</span>
          <ScheduleEditor value={schedule} onChange={setSchedule} idPrefix="continuous-schedule" />
        </div>

        <fieldset className="space-y-3">
          <legend className="mb-1 text-sm font-medium">{msg("continuous_tab.permit.label")}</legend>
          {(["data", "models", "optimizers"] as const).map((key) => (
            <div key={key} className="flex items-center gap-3">
              <Switch
                id={`continuous-permit-${key}`}
                checked={permitted[key]}
                onCheckedChange={toggle(key)}
              />
              <Label htmlFor={`continuous-permit-${key}`} className="text-sm font-normal">
                {msg(CHANGE_KEYS[key]!)}
              </Label>
            </div>
          ))}
        </fieldset>

        {permitted.data && (
          <div className="space-y-2">
            <span className="text-sm font-medium">{msg("continuous_tab.source.label")}</span>
            {connected.length === 0 ? (
              <p className="text-sm text-muted-foreground">{msg("continuous_tab.source.none")}</p>
            ) : (
              <div className="flex flex-col gap-2 sm:flex-row">
                <Select value={chosenProvider} onValueChange={setProvider}>
                  <SelectTrigger
                    className="sm:w-48"
                    aria-label={msg("continuous_tab.source.provider")}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {connected.map((c) => (
                      <SelectItem key={c.provider} value={c.provider}>
                        {providerMeta(c.provider as ConnectorProvider).name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  dir="ltr"
                  value={sourceRef}
                  onChange={(e) => setSourceRef(e.target.value)}
                  placeholder={msg("continuous_tab.source.ref_placeholder")}
                  aria-label={msg("continuous_tab.source.ref")}
                />
              </div>
            )}
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="continuous-limit">{msg("continuous_tab.limit.label")}</Label>
            <Input
              id="continuous-limit"
              dir="ltr"
              inputMode="decimal"
              value={monthlyLimit}
              onChange={(e) => setMonthlyLimit(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{msg("continuous_tab.limit.help")}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="continuous-cycle">{msg("continuous_tab.cycle_budget.label")}</Label>
            <Input
              id="continuous-cycle"
              dir="ltr"
              inputMode="decimal"
              value={cycleBudget}
              onChange={(e) => setCycleBudget(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {msg("continuous_tab.cycle_budget.help")}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            disabled={busy || problem != null}
            onClick={() =>
              onEnable({
                schedule,
                permitted,
                source:
                  permitted.data && chosenProvider
                    ? { provider: chosenProvider, ref: sourceRef.trim() }
                    : null,
                monthly_limit_cents: usdTextToCents(monthlyLimit) ?? 0,
                cycle_budget_cents: usdTextToCents(cycleBudget) ?? 0,
              })
            }
          >
            <Repeat className="size-4" />
            {msg("continuous_tab.enable.submit")}
          </Button>
          {problem && <span className="text-xs text-muted-foreground">{msg(problem)}</span>}
        </div>
        <p className="text-xs text-muted-foreground">
          {msg("continuous_tab.enable.no_auto_deploy")}
        </p>
      </CardContent>
    </Card>
  );
}

function PlanView({
  plan,
  busy,
  act,
}: {
  plan: ContinuousPlan;
  busy: boolean;
  act: (run: () => Promise<ContinuousPlan>) => Promise<void>;
}) {
  const locale = getActiveIntlLocale();
  const paused = plan.status === "paused";
  const { usage } = plan;
  const [editing, setEditing] = useState<ScheduleRule | null>(null);
  const checkRunning = plan.cycles.some(
    (c) => c.status === "checking" || c.status === "optimizing",
  );
  return (
    <div className="mt-4 space-y-4">
      <Card>
        <CardContent className="space-y-4 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-base font-semibold">{msg("continuous_tab.title")}</h3>
                <Badge variant={paused ? "outline" : "secondary"} size="sm">
                  {msg(paused ? "continuous_tab.status.paused" : "continuous_tab.status.active")}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                {paused && plan.pause_reason
                  ? msg(PAUSE_KEYS[plan.pause_reason])
                  : formatMsg("continuous_tab.next_check", {
                      when: formatWhen(plan.next_check_at),
                    })}
              </p>
              <p className="text-xs text-muted-foreground">
                {formatMsg("continuous_tab.refreshes", {
                  changes: (["data", "models", "optimizers"] as const)
                    .filter((key) => plan.permitted[key])
                    .map((key) => msg(CHANGE_KEYS[key]!))
                    .join(", "),
                })}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={busy || paused || checkRunning}
                title={msg(
                  paused
                    ? "continuous_tab.check_now.paused"
                    : checkRunning
                      ? "continuous_tab.check_now.busy"
                      : "continuous_tab.check_now.help",
                )}
                onClick={() =>
                  act(async () => {
                    const next = await checkContinuousNow(plan.id);
                    toast.success(msg("continuous_tab.check_now.started"));
                    return next;
                  })
                }
              >
                <ArrowClockwise className="size-4" />
                {msg("continuous_tab.check_now")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => act(() => setContinuousPaused(plan.id, !paused))}
              >
                {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
                {msg(paused ? "continuous_tab.resume" : "continuous_tab.pause")}
              </Button>
            </div>
          </div>

          <div className="rounded-lg border border-border/60 px-3.5 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium">{msg("continuous_tab.schedule.label")}</span>
              {editing === null && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => setEditing(plan.schedule)}
                >
                  <PencilSimple className="size-4" />
                  {msg("continuous_tab.schedule.edit")}
                </Button>
              )}
            </div>
            {editing === null ? (
              <div className="mt-1 space-y-1.5">
                <p className="text-sm">{describeSchedule(plan.schedule)}</p>
                {plan.upcoming_checks.length > 0 && (
                  <div className="text-xs text-muted-foreground">
                    <span>{msg("continuous_tab.schedule.next_checks")}</span>
                    <ul className="mt-0.5 space-y-0.5 text-foreground/80">
                      {plan.upcoming_checks.map((iso) => (
                        <li key={iso}>{formatCheck(iso, plan.schedule.timezone)}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ) : (
              <div className="mt-3 space-y-3">
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
                      })
                    }
                  >
                    {msg("continuous_tab.schedule.save")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => setEditing(null)}
                  >
                    {msg("continuous_tab.schedule.cancel")}
                  </Button>
                </div>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
              <span>
                {formatMsg("continuous_tab.allowance", {
                  used: formatCentsUsd(usage.committed_cents, locale),
                  limit: formatCentsUsd(usage.limit_cents, locale),
                })}
              </span>
              <span>
                {formatMsg("continuous_tab.allowance_resets", {
                  when: formatWhen(usage.resets_at),
                })}
              </span>
            </div>
            <ProgressBar value={allowanceShare(usage) * 100} />
            <p className="text-xs text-muted-foreground">
              {formatMsg("continuous_tab.cycle_budget.value", {
                amount: formatCentsUsd(plan.cycle_budget_cents, locale),
              })}
            </p>
          </div>

          <p className="text-xs text-muted-foreground">
            {msg("continuous_tab.incumbent")}{" "}
            <Link className="underline" href={`/optimizations/${plan.incumbent_optimization_id}`}>
              <bdi>{plan.incumbent_optimization_id.slice(0, 8)}</bdi>
            </Link>
          </p>
        </CardContent>
      </Card>

      {(plan.permitted.models || plan.permitted.optimizers) && (
        <StageInputs plan={plan} busy={busy} act={act} />
      )}

      <Card>
        <CardContent className="p-5">
          <h3 className="mb-3 text-sm font-semibold">{msg("continuous_tab.history")}</h3>
          {plan.cycles.length === 0 ? (
            <p className="text-sm text-muted-foreground">{msg("continuous_tab.history_empty")}</p>
          ) : (
            <ol className="divide-y divide-border/50">
              {plan.cycles.map((cycle) => (
                <CycleRow key={cycle.id} plan={plan} cycle={cycle} busy={busy} act={act} />
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
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
  act: (run: () => Promise<ContinuousPlan>) => Promise<void>;
}) {
  const [taskModel, setTaskModel] = useState(plan.pending_inputs.task_model ?? "");
  const [optimizer, setOptimizer] = useState(plan.pending_inputs.optimizer ?? "");
  const body = {
    ...(plan.permitted.models && taskModel.trim() ? { task_model: taskModel.trim() } : {}),
    ...(plan.permitted.optimizers && optimizer.trim() ? { optimizer: optimizer.trim() } : {}),
  };
  return (
    <Card>
      <CardContent className="space-y-3 p-5">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">{msg("continuous_tab.stage.title")}</h3>
          <p className="text-xs text-muted-foreground">{msg("continuous_tab.stage.description")}</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {plan.permitted.models && (
            <div className="space-y-1.5">
              <Label htmlFor="continuous-task-model">
                {msg("continuous_tab.stage.task_model")}
              </Label>
              <Input
                id="continuous-task-model"
                dir="ltr"
                value={taskModel}
                onChange={(e) => setTaskModel(e.target.value)}
              />
            </div>
          )}
          {plan.permitted.optimizers && (
            <div className="space-y-1.5">
              <Label htmlFor="continuous-optimizer">{msg("continuous_tab.stage.optimizer")}</Label>
              <Input
                id="continuous-optimizer"
                dir="ltr"
                value={optimizer}
                onChange={(e) => setOptimizer(e.target.value)}
              />
            </div>
          )}
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || Object.keys(body).length === 0}
          onClick={() => act(() => stageContinuousInputs(plan.id, body))}
        >
          {msg("continuous_tab.stage.submit")}
        </Button>
      </CardContent>
    </Card>
  );
}

function CycleRow({
  plan,
  cycle,
  busy,
  act,
}: {
  plan: ContinuousPlan;
  cycle: ContinuousCycle;
  busy: boolean;
  act: (run: () => Promise<ContinuousPlan>) => Promise<void>;
}) {
  const locale = getActiveIntlLocale();
  const scored = cycle.incumbent_score != null && cycle.candidate_score != null;
  return (
    <li className="space-y-1.5 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span
          className={cn(
            "rounded-full border px-2 py-0.5 text-xs font-medium",
            TONE_CLASS[cycleTone(cycle.status)],
          )}
        >
          {msg(STATUS_KEYS[cycle.status] ?? "continuous_tab.cycle.checking")}
        </span>
        <span className="text-muted-foreground">{formatWhen(cycle.created_at)}</span>
        {cycle.changes.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {formatMsg("continuous_tab.changed", {
              changes: cycle.changes
                .map((c) => (CHANGE_KEYS[c] ? msg(CHANGE_KEYS[c]) : c))
                .join(", "),
            })}
          </span>
        )}
      </div>
      {cycle.detail_code && (
        <p className="text-sm text-muted-foreground">
          {tI18n(cycle.detail_code, cycle.detail_params)}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {scored && (
          <span>
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
            className="inline-flex items-center gap-1 underline"
            href={`/optimizations/${cycle.optimization_id}`}
          >
            {msg("continuous_tab.open_run")}
            <ArrowSquareOut className="size-3 rtl:-scale-x-100" />
          </Link>
        )}
      </div>
      {canReview(cycle) && (
        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            size="sm"
            disabled={busy}
            onClick={() => act(() => reviewContinuousCycle(plan.id, cycle.id, true))}
          >
            <Check className="size-4" />
            {msg("continuous_tab.approve")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => act(() => reviewContinuousCycle(plan.id, cycle.id, false))}
          >
            <X className="size-4" />
            {msg("continuous_tab.reject")}
          </Button>
        </div>
      )}
    </li>
  );
}
