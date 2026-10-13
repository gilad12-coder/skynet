"use client";

import type { ReactNode } from "react";
import {
  ArrowClockwise,
  CheckCircle,
  CircleNotch,
  MinusCircle,
  Play,
  Warning,
  XCircle,
} from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import { InlineErrorRow } from "@/shared/ui/inline-error-row";
import { formatElapsedMs, formatScore } from "@/shared/lib/formatters";
import { contractCheckMessage } from "@/shared/lib/i18n";
import { msg } from "@/shared/lib/messages";
import { cn } from "@/shared/lib/utils";
import type { ContractCheckItem, ContractCheckResponse } from "@/shared/types/unified-run";
import type { ContractCheckState } from "../../hooks/use-contract-check";
import {
  contractSampleRows,
  contractStaticChecks,
  type ContractSampleRow,
} from "../../lib/contract-console";
import { v2Msg } from "./ArtifactConfirmCard";

const STATUS_ICON: Record<ContractCheckItem["status"], ReactNode> = {
  passed: (
    <CheckCircle className="size-3.5 shrink-0 text-[#5A7247] dark:text-[#adc899]" aria-hidden />
  ),
  failed: <XCircle className="size-3.5 shrink-0 text-destructive" aria-hidden />,
  pending: <CircleNotch className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />,
  skipped: <MinusCircle className="size-3.5 shrink-0 text-muted-foreground/70" aria-hidden />,
};

function CheckRow({ item, guided }: { item: ContractCheckItem; guided: boolean }) {
  return (
    <li className="space-y-1.5">
      <div className="flex items-start gap-2 text-xs">
        <span className="mt-px">{STATUS_ICON[item.status]}</span>
        <div className="min-w-0 space-y-0.5">
          <p className="font-medium text-foreground">
            {v2Msg(`submit.v2.metric.check.key.${item.key}`, guided)}
            {item.sample_index != null && (
              <span className="ms-1.5 font-normal text-muted-foreground">
                {v2Msg("submit.v2.metric.check.sample_ref", guided, {
                  index: item.sample_index + 1,
                })}
              </span>
            )}
          </p>
          <p className="text-muted-foreground" dir="auto">
            {contractCheckMessage(item)}
          </p>
        </div>
      </div>
      {item.detail && (
        <pre
          dir="ltr"
          className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md border border-destructive/25 bg-destructive/[0.04] p-2.5 font-mono text-[0.6875rem]/[1.55] text-foreground/90"
        >
          {item.detail}
        </pre>
      )}
    </li>
  );
}

function ResultStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="font-mono text-xs font-semibold tabular-nums text-foreground" dir="ltr">
        {value}
      </dd>
    </div>
  );
}

/** One sample's run, laid out like the sandbox test result: score, time, input, output, errors. */
function SampleRow({ row, guided }: { row: ContractSampleRow; guided: boolean }) {
  const { sample, failures } = row;
  const label = (key: string) => (
    <p className="text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground">
      {v2Msg(key, guided)}
    </p>
  );
  return (
    <li className="space-y-2 rounded-md border border-border/40 bg-background/70 p-2.5">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1">
        <span className="flex items-center gap-1.5 text-xs font-medium">
          {STATUS_ICON[failures.length > 0 ? "failed" : "passed"]}
          {v2Msg("submit.v2.metric.check.sample_title", guided, { index: sample.index + 1 })}
        </span>
        <dl className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
          <ResultStat
            label={msg("submit.blackbox.scorer.result_score")}
            value={formatScore(sample.score)}
          />
          {sample.duration_ms != null && (
            <ResultStat
              label={msg("submit.blackbox.scorer.result_time")}
              value={formatElapsedMs(sample.duration_ms)}
            />
          )}
        </dl>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="min-w-0 space-y-0.5">
          {label("submit.v2.metric.check.sample_input")}
          <p className="line-clamp-4 break-words font-mono text-[0.6875rem]" dir="auto">
            {sample.input_preview}
          </p>
        </div>
        <div className="min-w-0 space-y-0.5">
          {label("submit.v2.metric.check.sample_output")}
          <p className="line-clamp-4 break-words font-mono text-[0.6875rem]" dir="auto">
            {sample.output_preview ?? "—"}
          </p>
        </div>
      </div>
      {sample.feedback_preview && (
        <div className="min-w-0 space-y-0.5">
          {label("submit.v2.metric.check.sample_feedback")}
          <p
            className="whitespace-pre-wrap break-words text-[0.6875rem] text-foreground/90"
            dir="auto"
          >
            {sample.feedback_preview}
          </p>
        </div>
      )}
      {failures.length > 0 && (
        <ul className="space-y-2">
          {failures.map((item) => (
            <CheckRow key={item.key} item={item} guided={guided} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** One failed check as a line in an editor's console. */
export function contractConsoleLine(item: ContractCheckItem, guided: boolean): string {
  const where =
    item.sample_index != null
      ? `${v2Msg("submit.v2.metric.check.sample_title", guided, { index: item.sample_index + 1 })}: `
      : "";
  const head = `${where}${contractCheckMessage(item)}`;
  return item.detail ? `${head}\n${item.detail}` : head;
}

function failedStatic(result: ContractCheckResponse | null): ContractCheckItem[] {
  return result?.checks.filter((item) => item.status === "failed") ?? [];
}

/**
 * The pre-Run contract check: a debounced static hint while typing, and the
 * sandboxed check on a few samples whose fresh pass unblocks Run.
 */
export function ContractCheckPanel({
  cc,
  guided,
  blockedReason,
}: {
  cc: ContractCheckState;
  guided: boolean;
  /** Why Run is blocked, shown when no check has run yet. */
  blockedReason: string | null;
}) {
  const t = (key: string, params?: Record<string, string | number>) => v2Msg(key, guided, params);
  const last = cc.lastCheck;
  const staticFailures = failedStatic(cc.staticResult);
  const passed = !!last?.ok && !cc.stale;
  const sampleRows = contractSampleRows(last);

  return (
    <section
      aria-labelledby="v2-contract-title"
      className="space-y-3 border-t border-border/40 px-4 py-4 sm:px-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <h4 id="v2-contract-title" className="text-sm font-semibold">
            {t("submit.v2.metric.check.title")}
          </h4>
          <p className="text-xs text-muted-foreground">{t("submit.v2.metric.check.desc")}</p>
        </div>
        <Button
          type="button"
          variant={passed ? "outline" : "default"}
          onClick={() => void cc.check()}
          disabled={!cc.canCheck || cc.checking}
          className="min-h-[44px] w-full gap-2 sm:w-auto lg:min-h-0"
        >
          {cc.checking ? (
            <CircleNotch className="animate-spin motion-reduce:animate-none" aria-hidden />
          ) : last ? (
            <ArrowClockwise className="size-4" aria-hidden />
          ) : (
            <Play className="size-4" aria-hidden />
          )}
          {t(
            cc.checking
              ? "submit.v2.metric.check.running"
              : last
                ? "submit.v2.metric.check.rerun"
                : "submit.v2.metric.check.run",
          )}
        </Button>
      </div>

      {!cc.canCheck && (
        <p className="text-xs text-muted-foreground">{t("submit.v2.metric.check.incomplete")}</p>
      )}

      {staticFailures.length > 0 && (
        <div
          role="status"
          className="space-y-2 rounded-md border border-border/50 bg-muted/30 p-2.5"
        >
          <p className="text-[0.6875rem] font-medium text-muted-foreground">
            {t("submit.v2.metric.check.static_title")}
          </p>
          <ul className="space-y-2">
            {staticFailures.map((item) => (
              <CheckRow key={`static-${item.key}`} item={item} guided={guided} />
            ))}
          </ul>
        </div>
      )}

      {cc.error && (
        <InlineErrorRow title={t("submit.v2.metric.check.request_failed")} message={cc.error} />
      )}

      {last && cc.stale && (
        <p
          role="status"
          className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400"
        >
          <Warning className="size-3.5 shrink-0" aria-hidden />
          {t("submit.v2.metric.check.stale")}
        </p>
      )}

      {last && (
        <div className={cn("space-y-3", cc.stale && "opacity-60")} aria-live="polite">
          <p
            className={cn(
              "flex items-center gap-1.5 text-xs font-medium",
              last.ok ? "text-[#5A7247] dark:text-[#adc899]" : "text-destructive",
            )}
          >
            {last.ok ? (
              <CheckCircle className="size-3.5 shrink-0" aria-hidden />
            ) : (
              <XCircle className="size-3.5 shrink-0" aria-hidden />
            )}
            {t(last.ok ? "submit.v2.metric.check.passed" : "submit.v2.metric.check.failed")}
          </p>
          <ul className="space-y-2.5">
            {contractStaticChecks(last).map((item) => (
              <CheckRow key={item.key} item={item} guided={guided} />
            ))}
          </ul>
          {sampleRows.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground">
                {t("submit.v2.metric.check.samples")}
              </p>
              <ul className="space-y-2">
                {sampleRows.map((row) => (
                  <SampleRow key={row.sample.index} row={row} guided={guided} />
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {!last && blockedReason && cc.canCheck && (
        <p className="text-xs text-muted-foreground">{t("submit.v2.metric.check.needed")}</p>
      )}
    </section>
  );
}
