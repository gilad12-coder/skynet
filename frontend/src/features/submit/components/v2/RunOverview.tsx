"use client";

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { CheckCircle, Coins, Cpu, Database, Target, Warning, XCircle } from "@/shared/ui/icons";
import { msg, type MessageKey } from "@/shared/lib/messages";
import { getActiveIntlLocale } from "@/shared/lib/runtime-locale";
import { cn } from "@/shared/lib/utils";
import type { ContractCheckState } from "../../hooks/use-contract-check";
import type { WizardV2State } from "../../lib/wizard-v2";
import { v2Msg } from "./ArtifactConfirmCard";
import { optimizerLabel } from "./OptimizerPicker";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 border-b border-border/30 py-3 last:border-b-0 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm text-foreground">{children}</dd>
    </div>
  );
}

const DASH = "\u2014";

const TAB_ICONS: Record<OverviewTab, ReactNode> = {
  general: <Target className="size-3.5 shrink-0" aria-hidden />,
  data: <Database className="size-3.5 shrink-0" aria-hidden />,
  models: <Cpu className="size-3.5 shrink-0" aria-hidden />,
  budget: <Coins className="size-3.5 shrink-0" aria-hidden />,
};

/** A model id is code: keep it left-to-right inside Hebrew text. */
function ModelName({ name }: { name: string | undefined }) {
  if (!name) return <span className="text-muted-foreground">{DASH}</span>;
  return (
    <span className="break-all font-mono text-[13px]" dir="ltr">
      {name}
    </span>
  );
}

function CheckStatus({ cc, guided }: { cc: ContractCheckState; guided: boolean }) {
  const last = cc.lastCheck;
  const [key, tone, icon] = cc.checking
    ? (["submit.v2.metric.check.running", "muted", null] as const)
    : !last
      ? (["submit.v2.metric.check.needed", "muted", null] as const)
      : cc.stale
        ? ([
            "submit.v2.metric.check.stale",
            "warn",
            <Warning key="i" className="size-4 shrink-0" aria-hidden />,
          ] as const)
        : last.ok
          ? ([
              "submit.v2.metric.check.passed",
              "ok",
              <CheckCircle key="i" className="size-4 shrink-0" aria-hidden />,
            ] as const)
          : ([
              "submit.v2.metric.check.failed",
              "bad",
              <XCircle key="i" className="size-4 shrink-0" aria-hidden />,
            ] as const);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 font-medium",
        tone === "ok" && "text-[var(--success)]",
        tone === "warn" && "text-[var(--warning)]",
        tone === "bad" && "text-destructive",
        tone === "muted" && "text-muted-foreground",
      )}
    >
      {icon}
      {v2Msg(key, guided)}
    </span>
  );
}

type OverviewTab = "general" | "data" | "models" | "budget";

/**
 * The wizard's last screen: what the run will optimize, on what, with which
 * optimizer, and whether the contract check has passed. Run lives here, below
 * it, so it never sits over the code editors. The details sit in tabs so the
 * whole setup reads at a glance without a long scroll.
 */
export function RunOverview({
  state,
  cc,
  guided,
}: {
  state: WizardV2State;
  cc: ContractCheckState;
  guided: boolean;
}) {
  const t = (key: string, params?: Record<string, string | number>) => v2Msg(key, guided, params);
  const locale = getActiveIntlLocale();
  const fmt = (n: number) => new Intl.NumberFormat(locale).format(n);
  const pct = (n: number) => new Intl.NumberFormat(locale, { style: "percent" }).format(n);
  const yesNo = (on: boolean) => t(on ? "submit.v2.overview.yes" : "submit.v2.overview.no");
  const { task, inputs, optimizer, workspace, meta } = state;
  // A repository run reads its own files, so it has no data tab.
  const tabs: readonly OverviewTab[] = task.repo
    ? ["general", "models", "budget"]
    : ["general", "data", "models", "budget"];
  const [active, setActive] = useState<OverviewTab>("general");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const index = Math.max(0, tabs.indexOf(active));
  const baseId = useId();

  const data =
    inputs.datasetLabel !== null
      ? `${inputs.datasetLabel} · ${t("submit.v2.inputs.source.loaded", {
          rows: fmt(inputs.rowCount),
          cols: fmt(inputs.columns.length),
        })}`
      : t("submit.v2.overview.cases", { count: fmt(inputs.cases.length) });
  const reflectionModels = [optimizer.reflectionModel, ...optimizer.extraReflectionModels].filter(
    (m): m is NonNullable<typeof m> => m != null,
  );
  const metricModel =
    workspace.metricModelMode === "explicit" && workspace.metricModel
      ? workspace.metricModel.name
      : null;
  const limit = optimizer.budgetUncapped
    ? msg("submit.budget.uncapped_short" as MessageKey)
    : optimizer.maxCostCents != null
      ? // The billing barrel pulls in CSS, so the cap formats here; it is whole cents.
        new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(
          optimizer.maxCostCents / 100,
        )
      : DASH;

  /** Move focus between tabs with the arrow keys; the reading direction decides which way is "next". */
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    const step =
      event.key === "ArrowRight" ? (rtl ? -1 : 1) : event.key === "ArrowLeft" ? (rtl ? 1 : -1) : 0;
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : step
            ? (index + step + tabs.length) % tabs.length
            : -1;
    const target = tabs[next];
    if (next < 0 || !target) return;
    event.preventDefault();
    setActive(target);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-border/50 bg-card/80 shadow-lg backdrop-blur-xl">
      <header className="shrink-0 space-y-3 border-b border-border/30 px-4 py-3 sm:px-6">
        <div className="space-y-1">
          <h3 className="text-lg font-semibold tracking-tight text-foreground">
            {t("submit.v2.overview.title")}
          </h3>
          <p className="text-sm text-muted-foreground">{t("submit.v2.overview.desc")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="text-xs font-medium text-muted-foreground">
            {t("submit.v2.metric.check.title")}
          </span>
          {task.repo ? (
            <span className="text-muted-foreground">{t("submit.v2.repo.check_on_submit")}</span>
          ) : (
            <CheckStatus cc={cc} guided={guided} />
          )}
        </div>
      </header>
      <div
        role="tablist"
        aria-label={t("submit.v2.overview.tabs_label")}
        className="relative flex shrink-0 gap-0.5 border-b border-border bg-secondary/50 p-1"
      >
        <div
          aria-hidden
          className="pointer-events-none absolute bottom-1 top-1 rounded-lg bg-background shadow-sm transition-[inset-inline-start] duration-200 ease-out motion-reduce:transition-none"
          style={{
            width: `calc((100% - 8px - ${(tabs.length - 1) * 2}px) / ${tabs.length})`,
            insetInlineStart: `calc(4px + ${index} * ((100% - 8px - ${(tabs.length - 1) * 2}px) / ${tabs.length} + 2px))`,
          }}
        />
        {tabs.map((tab, i) => (
          <button
            key={tab}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${baseId}-tab-${tab}`}
            aria-selected={active === tab}
            aria-controls={`${baseId}-panel`}
            tabIndex={active === tab ? 0 : -1}
            onClick={() => setActive(tab)}
            onKeyDown={onKeyDown}
            className={cn(
              "relative z-10 flex min-h-[44px] flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:min-h-9",
              active === tab ? "text-foreground" : "text-muted-foreground hover:text-foreground/80",
            )}
          >
            {TAB_ICONS[tab]}
            <span>{t(`submit.v2.overview.tab.${tab}`)}</span>
          </button>
        ))}
      </div>
      <dl
        role="tabpanel"
        id={`${baseId}-panel`}
        aria-labelledby={`${baseId}-tab-${tabs[index]}`}
        className="min-h-0 flex-1 overflow-y-auto px-4 sm:px-6"
      >
        {tabs[index] === "general" && (
          <>
            <Row label={t("submit.v2.task.objective_label")}>
              <span className="line-clamp-4 whitespace-pre-wrap break-words">
                <bdi>{task.objective}</bdi>
              </span>
            </Row>
            {task.background.trim() && (
              <Row label={t("submit.v2.task.background_label")}>
                <span className="line-clamp-4 whitespace-pre-wrap break-words">
                  <bdi>{task.background}</bdi>
                </span>
              </Row>
            )}
            {task.repo ? (
              <Row label={t("submit.v2.repo.repository_label")}>
                <span className="break-all font-mono" dir="ltr">
                  {task.repo.repository}
                  {task.repo.commit.trim()
                    ? ` @ ${task.repo.commit.trim().slice(0, 7)}`
                    : task.repo.branch.trim()
                      ? ` @ ${task.repo.branch.trim()}`
                      : ""}
                </span>
              </Row>
            ) : (
              task.artifactKind && (
                <Row label={t("submit.v2.task.artifact.kind_label")}>
                  {t(`submit.v2.task.artifact.kind.${task.artifactKind}`)}
                </Row>
              )
            )}
            {meta.name.trim() && (
              <Row label={t("submit.v2.overview.row.name")}>
                <span className="break-words" dir="auto">
                  {meta.name}
                </span>
              </Row>
            )}
          </>
        )}
        {tabs[index] === "data" && (
          <>
            <Row label={t("submit.v2.overview.row.source")}>
              <span dir="auto">{data}</span>
            </Row>
            {inputs.datasetLabel !== null && inputs.inputFields.length > 0 && (
              <Row label={t("submit.v2.overview.row.input_columns")}>
                <span className="break-words font-mono" dir="auto">
                  {inputs.inputFields.join(", ")}
                </span>
              </Row>
            )}
            {inputs.datasetLabel !== null && inputs.expectedField && (
              <Row label={t("submit.v2.overview.row.expected_column")}>
                <span className="break-words font-mono" dir="auto">
                  {inputs.expectedField}
                </span>
              </Row>
            )}
            <Row label={t("submit.v2.overview.row.split")}>
              <span className="flex flex-wrap gap-x-3 gap-y-1 tabular-nums">
                <span>
                  {msg("submit.split.label_train")} <bdi>{pct(inputs.split.train)}</bdi>
                </span>
                <span>
                  {msg("submit.split.label_val")} <bdi>{pct(inputs.split.val)}</bdi>
                </span>
                <span>
                  {msg("submit.split.label_test")} <bdi>{pct(inputs.split.test)}</bdi>
                </span>
              </span>
            </Row>
            <Row label={t("submit.v2.overview.row.shuffle")}>{yesNo(inputs.shuffle)}</Row>
          </>
        )}
        {tabs[index] === "models" && (
          <>
            <Row label={msg("submit.v2.stage.optimizer" as MessageKey)}>
              {optimizerLabel(optimizer.choice, guided)}
            </Row>
            <Row label={t("submit.v2.optimizer.models.task.label")}>
              <ModelName name={optimizer.taskModel?.name} />
            </Row>
            <Row label={t("submit.v2.optimizer.models.reflection.label")}>
              {reflectionModels.length ? (
                <span className="flex flex-col gap-0.5">
                  {reflectionModels.map((m, i) => (
                    <ModelName key={`${m.name}-${i}`} name={m.name} />
                  ))}
                </span>
              ) : (
                DASH
              )}
            </Row>
            {!task.repo && (
              <Row label={t("submit.v2.metric.model.label")}>
                {metricModel ? (
                  <ModelName name={metricModel} />
                ) : (
                  t("submit.v2.metric.model.inherit")
                )}
              </Row>
            )}
          </>
        )}
        {tabs[index] === "budget" && (
          <>
            <Row label={msg("submit.budget.label" as MessageKey)}>
              <bdi className="tabular-nums">{limit}</bdi>
            </Row>
            <Row label={t("submit.v2.optimizer.budget.max_runs")}>
              <bdi className="tabular-nums">{fmt(optimizer.budget.max_scorer_runs)}</bdi>
            </Row>
            {optimizer.budget.max_iterations != null && (
              <Row label={t("submit.v2.optimizer.budget.max_iterations")}>
                <bdi className="tabular-nums">{fmt(optimizer.budget.max_iterations)}</bdi>
              </Row>
            )}
            <Row label={msg("submit.economy.label" as MessageKey)}>{yesNo(meta.economyMode)}</Row>
          </>
        )}
      </dl>
    </div>
  );
}
