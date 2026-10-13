"use client";

import type { ReactNode } from "react";
import { CheckCircle, Warning, XCircle } from "@/shared/ui/icons";
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

function CheckStatus({ cc, guided }: { cc: ContractCheckState; guided: boolean }) {
  const last = cc.lastCheck;
  const [key, tone, icon] = !last
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
        tone === "ok" && "text-[#5A7247] dark:text-[#adc899]",
        tone === "warn" && "text-amber-700 dark:text-amber-400",
        tone === "bad" && "text-destructive",
        tone === "muted" && "text-muted-foreground",
      )}
    >
      {icon}
      {v2Msg(key, guided)}
    </span>
  );
}

/**
 * The wizard's last screen: what the run will optimize, on what, with which
 * optimizer, and whether the contract check has passed. Run lives here, below
 * it, so it never sits over the code editors.
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
  const fmt = (n: number) => new Intl.NumberFormat(getActiveIntlLocale()).format(n);
  const { task, inputs, optimizer } = state;
  const data =
    inputs.datasetLabel !== null
      ? `${inputs.datasetLabel} · ${t("submit.v2.inputs.source.loaded", {
          rows: fmt(inputs.rowCount),
          cols: fmt(inputs.columns.length),
        })}`
      : t("submit.v2.overview.cases", { count: fmt(inputs.cases.length) });

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-border/50 bg-card/80 backdrop-blur-xl">
      <header className="shrink-0 space-y-1 border-b border-border/30 px-4 py-3 sm:px-6">
        <h3 className="text-lg font-semibold tracking-tight text-foreground">
          {t("submit.v2.overview.title")}
        </h3>
        <p className="text-sm text-muted-foreground">{t("submit.v2.overview.desc")}</p>
      </header>
      <dl className="min-h-0 flex-1 overflow-y-auto px-4 sm:px-6">
        <Row label={t("submit.v2.task.objective_label")}>
          <span className="line-clamp-4 whitespace-pre-wrap break-words" dir="auto">
            {task.objective}
          </span>
        </Row>
        {task.artifactKind && (
          <Row label={t("submit.v2.task.artifact.kind_label")}>
            {t(`submit.v2.task.artifact.kind.${task.artifactKind}`)}
          </Row>
        )}
        <Row label={msg("submit.v2.stage.inputs" as MessageKey)}>
          <span dir="auto">{data}</span>
        </Row>
        <Row label={msg("submit.v2.stage.optimizer" as MessageKey)}>
          {optimizerLabel(optimizer.choice, guided)}
        </Row>
        <Row label={t("submit.v2.metric.check.title")}>
          <CheckStatus cc={cc} guided={guided} />
        </Row>
      </dl>
    </div>
  );
}
