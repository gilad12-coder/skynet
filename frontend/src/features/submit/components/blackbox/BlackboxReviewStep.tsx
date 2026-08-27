"use client";

import type { ReactNode } from "react";
import { Badge } from "@/shared/ui/primitives/badge";
import { formatCredits } from "@/features/billing";
import { TERMS } from "@/shared/lib/terms";
import { formatMsg, msg } from "@/shared/lib/messages";
import { getActiveIntlLocale } from "@/shared/lib/runtime-locale";

import type { BlackboxWizardContext } from "../../hooks/use-blackbox-wizard";
import { chargeableBracket } from "../../lib/cost-bracket";
import { StepCard } from "./shared";

function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-start sm:gap-4">
      <dt className="shrink-0 text-xs font-medium text-muted-foreground sm:w-36">{label}</dt>
      <dd className="min-w-0 text-sm text-foreground" dir="auto">
        {children}
      </dd>
    </div>
  );
}

export function BlackboxReviewStep({ w }: { w: BlackboxWizardContext }) {
  const {
    jobName,
    isPrivate,
    seedMode,
    seedText,
    seedParts,
    objective,
    targetKind,
    harness,
    targetModel,
    parsedCases,
    scorerKind,
    scorerUrl,
    strategyMode,
    selectedEngine,
    maxScorerRuns,
    maxIterations,
    stopAtScore,
    reflectionModel,
    costBracket,
    tokenSource,
    maxCostCredits,
  } = w;
  const locale = getActiveIntlLocale();
  const bracket = chargeableBracket(costBracket, tokenSource);

  const startSummary =
    seedMode === "none"
      ? msg("submit.blackbox.review.start_none")
      : seedMode === "text"
        ? formatMsg("submit.blackbox.review.start_text", { chars: seedText.length })
        : formatMsg("submit.blackbox.review.start_parts", {
            n: seedParts.filter((p) => p.key.trim() && p.value.trim()).length,
          });

  return (
    <StepCard
      title={msg("auto.features.submit.constants.literal.4")}
      description={msg("submit.blackbox.review.desc")}
    >
      <dl className="divide-y divide-border/40">
        {jobName.trim() && (
          <Row label={msg("auto.features.submit.components.steps.basicsstep.3")}>{jobName}</Row>
        )}
        <Row label={msg("submit.blackbox.review.start")}>{startSummary}</Row>
        {objective.trim() && (
          <Row label={msg("submit.blackbox.start.objective_label")}>
            <span className="line-clamp-3 whitespace-pre-wrap">{objective}</span>
          </Row>
        )}
        <Row label={msg("submit.blackbox.start.target_label")}>
          {targetKind === "text"
            ? msg("submit.blackbox.start.target.text")
            : `${msg("submit.blackbox.start.target.agent")} · ${harness} · ${targetModel}`}
        </Row>
        <Row label={msg("submit.blackbox.cases.title")}>
          {parsedCases
            ? formatMsg("submit.blackbox.cases.loaded", {
                rows: parsedCases.rowCount,
                cols: parsedCases.columns.length,
              })
            : msg("submit.blackbox.review.cases_none")}
        </Row>
        <Row label={msg("submit.blackbox.scorer.title")}>
          {scorerKind === "python" ? (
            msg("submit.blackbox.scorer.kind.python")
          ) : (
            <span className="font-mono text-xs" dir="ltr">
              {scorerUrl}
            </span>
          )}
        </Row>
        <Row label={msg("submit.blackbox.review.strategy")}>
          {strategyMode === "auto"
            ? msg("submit.blackbox.strategy.auto")
            : (selectedEngine?.label ?? msg("submit.blackbox.strategy.single"))}
        </Row>
        <Row label={msg("submit.blackbox.review.budget")}>
          <span className="flex flex-wrap gap-1.5">
            <Badge variant="outline">
              {formatMsg("submit.blackbox.review.budget_runs", { runs: maxScorerRuns })}
            </Badge>
            {maxIterations !== "" && (
              <Badge variant="outline">
                {formatMsg("submit.blackbox.review.budget_iterations", { n: maxIterations })}
              </Badge>
            )}
            {stopAtScore.trim() && (
              <Badge variant="outline">
                {formatMsg("submit.blackbox.review.budget_stop", { score: stopAtScore.trim() })}
              </Badge>
            )}
          </span>
        </Row>
        <Row label={TERMS.reflectionModel}>
          <span className="font-mono text-xs" dir="ltr">
            {reflectionModel.name}
          </span>
        </Row>
        <Row label={msg("submit.cost_ceiling.label")}>
          {formatMsg("submit.cost_ceiling.bracket", {
            low: formatCredits(bracket.lowCredits, locale),
            high: formatCredits(bracket.highCredits, locale),
          })}
          {maxCostCredits != null && (
            <span className="ms-2 text-xs text-muted-foreground">
              {formatMsg("submit.nav.run_cap", { credits: formatCredits(maxCostCredits, locale) })}
            </span>
          )}
        </Row>
        <Row label={msg("submit.basics.privacy.label")}>
          {msg(isPrivate ? "submit.basics.privacy.private" : "submit.basics.privacy.public")}
        </Row>
      </dl>
    </StepCard>
  );
}
