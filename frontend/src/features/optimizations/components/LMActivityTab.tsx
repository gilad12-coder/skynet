"use client";

import type { ReactNode } from "react";
import { ChatText, Pulse, Timer } from "@/shared/ui/icons";
import { FadeIn } from "@/shared/ui/motion";
import { HelpTip } from "@/shared/ui/help-tip";
import { ExportTableMenu } from "@/shared/ui/export-table-menu";
import { formatMsg, msg } from "@/shared/lib/messages";
import { getActiveIntlLocale } from "@/shared/lib/runtime-locale";
import { tip } from "@/shared/lib/tooltips";
import type {
  BlackboxRunResult,
  LMActivity,
  LMStageStats,
  ModelTokenUsage,
} from "@/shared/types/api";

const STAGE_KEYS = ["baseline", "training", "evaluation"] as const;
type StageKey = (typeof STAGE_KEYS)[number];

const STAGE_MESSAGE_KEYS: Record<
  StageKey,
  | "auto.features.optimizations.components.lmactivitytab.stage_baseline"
  | "auto.features.optimizations.components.lmactivitytab.stage_training"
  | "auto.features.optimizations.components.lmactivitytab.stage_evaluation"
> = {
  baseline: "auto.features.optimizations.components.lmactivitytab.stage_baseline",
  training: "auto.features.optimizations.components.lmactivitytab.stage_training",
  evaluation: "auto.features.optimizations.components.lmactivitytab.stage_evaluation",
};

const STAGE_TIP_KEYS: Record<
  StageKey,
  "lm_activity.stage.baseline" | "lm_activity.stage.training" | "lm_activity.stage.evaluation"
> = {
  baseline: "lm_activity.stage.baseline",
  training: "lm_activity.stage.training",
  evaluation: "lm_activity.stage.evaluation",
};

function aggregateColumn(perStage: Record<string, LMStageStats>): {
  calls: number;
  avg_response_time_ms: number | null;
} {
  // Weighted mean across stages: ``avg_ms`` per stage is itself a mean, so
  // multiply by per-stage call count before reducing.
  let totalCalls = 0;
  let weighted = 0;
  let weighted_n = 0;
  for (const cell of Object.values(perStage)) {
    const calls = cell?.calls ?? 0;
    totalCalls += calls;
    if (calls > 0 && typeof cell?.avg_response_time_ms === "number") {
      weighted += cell.avg_response_time_ms * calls;
      weighted_n += calls;
    }
  }
  return {
    calls: totalCalls,
    avg_response_time_ms: weighted_n > 0 ? weighted / weighted_n : null,
  };
}

function formatCalls(n: number): string {
  return n.toLocaleString(getActiveIntlLocale());
}

// Unified to seconds so the eye doesn't re-parse units row to row. Sub-100ms
// shows ``<0.1s`` rather than ``42ms`` to keep the column dimension uniform —
// the diagnostic question is "where did time go", so consistent scale wins
// over per-cell precision at the millisecond floor.
function formatSeconds(ms: number | null | undefined): string {
  if (ms == null) return msg("common.empty");
  const seconds = ms / 1000;
  if (seconds < 0.1) return msg("optimizations.duration.lt_0_1s");
  return formatMsg("optimizations.duration.seconds", { value: seconds.toFixed(1) });
}

function MetricCells({
  calls,
  ms,
  emphasized = false,
  groupStart = false,
}: {
  calls: number;
  ms: number | null;
  emphasized?: boolean;
  groupStart?: boolean;
}) {
  const empty = calls === 0;
  const numeric = emphasized ? "font-semibold text-foreground" : "font-normal text-foreground";
  const numericMuted = emphasized ? "text-foreground" : "text-muted-foreground";
  return (
    <>
      <td
        className={`px-3 py-2.5 text-end align-middle ${
          groupStart ? "border-s border-border/50" : ""
        }`}
      >
        {empty ? (
          <span className="text-[var(--text-3)]">—</span>
        ) : (
          <span className={`font-mono tabular-nums text-sm ${numeric}`} dir="ltr">
            {formatCalls(calls)}
          </span>
        )}
      </td>
      <td className="px-3 py-2.5 text-end align-middle">
        {empty ? (
          <span className="text-[var(--text-3)]">—</span>
        ) : (
          <span className={`font-mono tabular-nums text-sm ${numericMuted}`} dir="ltr">
            {formatSeconds(ms)}
          </span>
        )}
      </td>
    </>
  );
}

function StageRow({
  stage,
  generation,
  reflection,
  hasGeneration,
  hasReflection,
}: {
  stage: StageKey;
  generation: LMStageStats | undefined;
  reflection: LMStageStats | undefined;
  hasGeneration: boolean;
  hasReflection: boolean;
}) {
  return (
    <tr className="border-t border-border/40 transition-colors hover:bg-muted/30">
      <th
        scope="row"
        className="px-3 py-2.5 text-start text-sm font-medium text-foreground whitespace-nowrap"
      >
        <HelpTip text={tip(STAGE_TIP_KEYS[stage])}>{msg(STAGE_MESSAGE_KEYS[stage])}</HelpTip>
      </th>
      {hasGeneration && (
        <MetricCells
          calls={generation?.calls ?? 0}
          ms={generation?.avg_response_time_ms ?? null}
          groupStart
        />
      )}
      {hasReflection && (
        <MetricCells
          calls={reflection?.calls ?? 0}
          ms={reflection?.avg_response_time_ms ?? null}
          groupStart
        />
      )}
    </tr>
  );
}

function TotalRow({
  generation,
  reflection,
  hasGeneration,
  hasReflection,
}: {
  generation: { calls: number; avg_response_time_ms: number | null };
  reflection: { calls: number; avg_response_time_ms: number | null };
  hasGeneration: boolean;
  hasReflection: boolean;
}) {
  return (
    <tr className="border-t border-border bg-muted/20">
      <th
        scope="row"
        className="px-3 py-3 text-start text-sm font-bold text-foreground whitespace-nowrap"
      >
        <HelpTip text={tip("lm_activity.total_row")}>
          {msg("auto.features.optimizations.components.lmactivitytab.row_total")}
        </HelpTip>
      </th>
      {hasGeneration && (
        <MetricCells
          calls={generation.calls}
          ms={generation.avg_response_time_ms}
          emphasized
          groupStart
        />
      )}
      {hasReflection && (
        <MetricCells
          calls={reflection.calls}
          ms={reflection.avg_response_time_ms}
          emphasized
          groupStart
        />
      )}
    </tr>
  );
}

function SubHeader({
  tipKey,
  icon,
  label,
  groupStart = false,
}: {
  tipKey: "lm_activity.cell.calls" | "lm_activity.cell.avg_ms";
  icon: ReactNode;
  label: string;
  groupStart?: boolean;
}) {
  return (
    <th
      scope="col"
      className={`px-3 pb-2 pt-1 text-end text-[11px] font-medium uppercase tracking-wide text-muted-foreground whitespace-nowrap ${
        groupStart ? "border-s border-border/50" : ""
      }`}
    >
      <HelpTip text={tip(tipKey)}>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="text-muted-foreground/70">
            {icon}
          </span>
          {label}
        </span>
      </HelpTip>
    </th>
  );
}

export function LMActivityTab({ lmActivity }: { lmActivity: LMActivity | null | undefined }) {
  return (
    <FadeIn>
      <p className="text-sm text-muted-foreground mb-4">
        {msg("optimizations.lmactivity.description")}
      </p>
      <LMActivityMatrix lmActivity={lmActivity} />
    </FadeIn>
  );
}

/**
 * The per-stage calls / avg-response-time matrix, shared between the regular
 * and black-box activity tabs so both report timing in the same terms.
 */
function LMActivityMatrix({
  lmActivity,
  sectionTip,
}: {
  lmActivity: LMActivity | null | undefined;
  sectionTip?: string;
}) {
  const generation = lmActivity?.generation ?? {};
  const reflection = lmActivity?.reflection ?? {};
  // Hide the reflection column entirely when no reflection traffic was recorded —
  // unoptimized runs and grid pairs that didn't reach reflection should not show
  // a column full of em-dashes.
  const hasReflection = Object.values(reflection).some((c) => (c?.calls ?? 0) > 0);
  // Symmetric hide for generation: black-box runs drive only a reflection
  // model, so an all-dash generation column would be noise. Both-empty falls
  // through to the no-data state, so at least one column always renders.
  const hasGeneration =
    !hasReflection || Object.values(generation).some((c) => (c?.calls ?? 0) > 0);
  const hasAnyCalls = hasReflection || Object.values(generation).some((c) => (c?.calls ?? 0) > 0);

  const genTotal = aggregateColumn(generation);
  const reflTotal = aggregateColumn(reflection);

  const callsLabel = msg("auto.features.optimizations.components.lmactivitytab.cell_calls");
  const avgMsLabel = msg("auto.features.optimizations.components.lmactivitytab.cell_avg_ms");
  const stageLabel = msg("auto.features.optimizations.components.lmactivitytab.col_stage");
  const genLabel = msg("auto.features.optimizations.components.lmactivitytab.col_generation");
  const reflLabel = msg("auto.features.optimizations.components.lmactivitytab.col_reflection");

  const callsIcon = <ChatText className="size-3" />;
  const avgIcon = <Timer className="size-3" />;

  // Plain ``<section>`` instead of ``<Card>`` to opt out of the global
  // ``[data-slot="card"]`` chrome (gradient bg, backdrop-blur, mouse-spotlight,
  // hover-lift, top hairline). This card is a quiet diagnostic surface; the
  // ornamental defaults fight that intent.
  return (
    <section
      aria-labelledby="lm-activity-title"
      data-tutorial="lm-activity"
      className="rounded-2xl border border-border bg-card text-card-foreground shadow-[var(--shadow-sm)]"
    >
      <header className="flex items-center gap-2 px-6 pt-5 pb-3">
        <Pulse className="size-4 text-muted-foreground" aria-hidden="true" />
        <HelpTip text={sectionTip ?? tip("lm_activity.section")}>
          <h3 id="lm-activity-title" className="m-0 text-lg font-bold text-foreground">
            {msg("auto.features.optimizations.components.lmactivitytab.title")}
          </h3>
        </HelpTip>
        <ExportTableMenu
          iconOnly
          className="ms-auto"
          disabled={!hasAnyCalls}
          getData={() => {
            const stageCol = stageLabel;
            const genCallsCol = `${genLabel} · ${callsLabel}`;
            const genAvgCol = `${genLabel} · ${avgMsLabel}`;
            const reflCallsCol = `${reflLabel} · ${callsLabel}`;
            const reflAvgCol = `${reflLabel} · ${avgMsLabel}`;
            const columns = [stageCol];
            if (hasGeneration) columns.push(genCallsCol, genAvgCol);
            if (hasReflection) columns.push(reflCallsCol, reflAvgCol);
            const toRow = (
              name: string,
              gen: { calls?: number; avg_response_time_ms?: number | null } | undefined,
              refl: { calls?: number; avg_response_time_ms?: number | null } | undefined,
            ): Record<string, unknown> => {
              const out: Record<string, unknown> = { [stageCol]: name };
              if (hasGeneration) {
                out[genCallsCol] = gen?.calls ?? 0;
                out[genAvgCol] = gen?.avg_response_time_ms ?? null;
              }
              if (hasReflection) {
                out[reflCallsCol] = refl?.calls ?? 0;
                out[reflAvgCol] = refl?.avg_response_time_ms ?? null;
              }
              return out;
            };
            return {
              columns,
              rows: [
                ...STAGE_KEYS.map((stage) =>
                  toRow(msg(STAGE_MESSAGE_KEYS[stage]), generation[stage], reflection[stage]),
                ),
                toRow(
                  msg("auto.features.optimizations.components.lmactivitytab.row_total"),
                  genTotal,
                  reflTotal,
                ),
              ],
              filename: "lm_activity",
            };
          }}
        />
      </header>
      <div className="px-6 pb-5">
        {!hasAnyCalls ? (
          <p className="text-sm text-muted-foreground">
            {msg("auto.features.optimizations.components.lmactivitytab.no_data")}
          </p>
        ) : (
          <div className="overflow-x-auto -mx-2 px-2">
            <table className="guide-table w-full text-sm">
              <thead>
                <tr className="bg-muted/20">
                  <th
                    scope="col"
                    rowSpan={2}
                    className="px-3 py-2 text-start text-[11px] font-semibold uppercase tracking-wide text-muted-foreground align-bottom whitespace-nowrap"
                  >
                    <span className="sr-only">{stageLabel}</span>
                  </th>
                  {hasGeneration && (
                    <th
                      scope="colgroup"
                      colSpan={2}
                      className="px-3 pt-2 pb-1 text-center text-xs font-semibold text-foreground border-s border-border/50 whitespace-nowrap"
                    >
                      <HelpTip text={tip("lm_activity.column.generation")}>{genLabel}</HelpTip>
                    </th>
                  )}
                  {hasReflection && (
                    <th
                      scope="colgroup"
                      colSpan={2}
                      className="px-3 pt-2 pb-1 text-center text-xs font-semibold text-foreground border-s border-border/50 whitespace-nowrap"
                    >
                      <HelpTip text={tip("lm_activity.column.reflection")}>{reflLabel}</HelpTip>
                    </th>
                  )}
                </tr>
                <tr className="bg-muted/20">
                  {hasGeneration && (
                    <>
                      <SubHeader
                        tipKey="lm_activity.cell.calls"
                        icon={callsIcon}
                        label={callsLabel}
                        groupStart
                      />
                      <SubHeader
                        tipKey="lm_activity.cell.avg_ms"
                        icon={avgIcon}
                        label={avgMsLabel}
                      />
                    </>
                  )}
                  {hasReflection && (
                    <>
                      <SubHeader
                        tipKey="lm_activity.cell.calls"
                        icon={callsIcon}
                        label={callsLabel}
                        groupStart
                      />
                      <SubHeader
                        tipKey="lm_activity.cell.avg_ms"
                        icon={avgIcon}
                        label={avgMsLabel}
                      />
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {STAGE_KEYS.map((stage) => (
                  <StageRow
                    key={stage}
                    stage={stage}
                    generation={generation[stage]}
                    reflection={reflection[stage]}
                    hasGeneration={hasGeneration}
                    hasReflection={hasReflection}
                  />
                ))}
                <TotalRow
                  generation={genTotal}
                  reflection={reflTotal}
                  hasGeneration={hasGeneration}
                  hasReflection={hasReflection}
                />
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * Black-box variant of the activity tab: the shared per-stage timing matrix
 * for the reflection model (older runs predate the recording and skip it),
 * plus per-model token totals for every LM the run touched — including the
 * scorer's llm() calls, which run out of process and cannot be timed.
 */
export function BlackboxLMActivityTab({ result }: { result: BlackboxRunResult }) {
  const rows: ModelTokenUsage[] = (result.usage_by_model ?? []).flatMap((u) =>
    typeof u.model === "string" &&
    typeof u.input_tokens === "number" &&
    typeof u.output_tokens === "number"
      ? [{ model: u.model, input_tokens: u.input_tokens, output_tokens: u.output_tokens }]
      : [],
  );
  const totals = rows.reduce(
    (acc, u) => ({ input: acc.input + u.input_tokens, output: acc.output + u.output_tokens }),
    { input: 0, output: 0 },
  );

  const modelLabel = msg("usage.col.model");
  const inputLabel = msg("optimization.blackbox.stats.input_col");
  const outputLabel = msg("optimization.blackbox.stats.output_col");
  const tokensLabel = msg("usage.col.tokens");
  const headCls =
    "px-3 py-2 text-end text-[11px] font-semibold uppercase tracking-wide text-muted-foreground whitespace-nowrap";
  const cellCls = "px-3 py-2.5 text-end align-middle";

  return (
    <FadeIn>
      <p className="text-sm text-muted-foreground mb-4">
        {msg("optimization.blackbox.lmactivity.description")}
      </p>
      {result.lm_activity && (
        <div className="mb-4">
          <LMActivityMatrix
            lmActivity={result.lm_activity}
            sectionTip={tip("blackbox.lm_activity.section")}
          />
        </div>
      )}
      <section
        aria-labelledby="blackbox-lm-activity-title"
        className="rounded-2xl border border-border bg-card text-card-foreground shadow-[var(--shadow-sm)]"
      >
        <header className="flex items-center gap-2 px-6 pt-5 pb-3">
          <Pulse className="size-4 text-muted-foreground" aria-hidden="true" />
          <HelpTip text={tip("blackbox.model_activity.section")}>
            <h3 id="blackbox-lm-activity-title" className="m-0 text-lg font-bold text-foreground">
              {msg("optimization.blackbox.lmactivity.title")}
            </h3>
          </HelpTip>
          <ExportTableMenu
            iconOnly
            className="ms-auto"
            disabled={rows.length === 0}
            getData={() => ({
              columns: [modelLabel, inputLabel, outputLabel, tokensLabel],
              rows: rows.map((u) => ({
                [modelLabel]: u.model,
                [inputLabel]: u.input_tokens,
                [outputLabel]: u.output_tokens,
                [tokensLabel]: u.input_tokens + u.output_tokens,
              })),
              filename: "lm_activity",
            })}
          />
        </header>
        <div className="px-6 pb-5">
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {msg("auto.features.optimizations.components.lmactivitytab.no_data")}
            </p>
          ) : (
            <div className="overflow-x-auto -mx-2 px-2">
              <table className="guide-table w-full text-sm">
                <thead>
                  <tr className="bg-muted/20">
                    <th
                      scope="col"
                      className="px-3 py-2 text-start text-[11px] font-semibold uppercase tracking-wide text-muted-foreground whitespace-nowrap"
                    >
                      {modelLabel}
                    </th>
                    <th scope="col" className={headCls}>
                      <HelpTip text={tip("blackbox.tokens.input")}>{inputLabel}</HelpTip>
                    </th>
                    <th scope="col" className={headCls}>
                      <HelpTip text={tip("blackbox.tokens.output")}>{outputLabel}</HelpTip>
                    </th>
                    <th scope="col" className={headCls}>
                      <HelpTip text={tip("blackbox.tokens.total")}>{tokensLabel}</HelpTip>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((u) => (
                    <tr
                      key={u.model}
                      className="border-t border-border/40 transition-colors hover:bg-muted/30"
                    >
                      <th
                        scope="row"
                        dir="ltr"
                        title={u.model}
                        className="px-3 py-2.5 text-start font-mono text-sm font-medium text-foreground whitespace-nowrap"
                      >
                        {u.model}
                      </th>
                      <td className={cellCls}>
                        <span
                          className="font-mono tabular-nums text-sm text-muted-foreground"
                          dir="ltr"
                        >
                          {formatCalls(u.input_tokens)}
                        </span>
                      </td>
                      <td className={cellCls}>
                        <span
                          className="font-mono tabular-nums text-sm text-muted-foreground"
                          dir="ltr"
                        >
                          {formatCalls(u.output_tokens)}
                        </span>
                      </td>
                      <td className={cellCls}>
                        <span
                          className="font-mono tabular-nums text-sm font-normal text-foreground"
                          dir="ltr"
                        >
                          {formatCalls(u.input_tokens + u.output_tokens)}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {rows.length > 1 && (
                    <tr className="border-t border-border bg-muted/20">
                      <th
                        scope="row"
                        className="px-3 py-3 text-start text-sm font-bold text-foreground whitespace-nowrap"
                      >
                        <HelpTip text={tip("blackbox.tokens.total_row")}>
                          {msg("auto.features.optimizations.components.lmactivitytab.row_total")}
                        </HelpTip>
                      </th>
                      <td className={cellCls}>
                        <span
                          className="font-mono tabular-nums text-sm font-semibold text-foreground"
                          dir="ltr"
                        >
                          {formatCalls(totals.input)}
                        </span>
                      </td>
                      <td className={cellCls}>
                        <span
                          className="font-mono tabular-nums text-sm font-semibold text-foreground"
                          dir="ltr"
                        >
                          {formatCalls(totals.output)}
                        </span>
                      </td>
                      <td className={cellCls}>
                        <span
                          className="font-mono tabular-nums text-sm font-semibold text-foreground"
                          dir="ltr"
                        >
                          {formatCalls(totals.input + totals.output)}
                        </span>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </FadeIn>
  );
}
