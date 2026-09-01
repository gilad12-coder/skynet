"use client";

import type { ReactNode } from "react";
import { Badge } from "@/shared/ui/primitives/badge";
import { HelpTip } from "@/shared/ui/help-tip";
import { formatCredits } from "@/features/billing";
import { TERMS } from "@/shared/lib/terms";
import { formatMsg, msg } from "@/shared/lib/messages";
import { tip as tipText, type TooltipKey } from "@/shared/lib/tooltips";
import { getActiveIntlLocale } from "@/shared/lib/runtime-locale";

import type { BlackboxWizardContext } from "../../hooks/use-blackbox-wizard";
import { chargeableBracket } from "../../lib/cost-bracket";
import { StepCard } from "./shared";

function Row({ label, tip, children }: { label: ReactNode; tip: TooltipKey; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-start sm:gap-4">
      <dt className="shrink-0 text-xs font-medium text-muted-foreground sm:w-36">
        <HelpTip text={tipText(tip)}>{label}</HelpTip>
      </dt>
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
    background,
    targetKind,
    harness,
    targetModel,
    parsedCases,
    split,
    shuffle,
    scorerKind,
    scorerUrl,
    scorerModel,
    scorerInstall,
    strategyMode,
    selectedEngine,
    patience,
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
          <Row label={msg("auto.features.submit.components.steps.basicsstep.3")} tip="submit.name">
            {jobName}
          </Row>
        )}
        <Row label={msg("submit.blackbox.review.start")} tip="submit.blackbox.review_start">
          {startSummary}
        </Row>
        {objective.trim() && (
          <Row label={msg("submit.blackbox.start.objective_label")} tip="submit.blackbox.objective">
            <span className="line-clamp-3 whitespace-pre-wrap">{objective}</span>
          </Row>
        )}
        {background.trim() && (
          <Row
            label={msg("submit.blackbox.start.background_label")}
            tip="submit.blackbox.background"
          >
            <span className="line-clamp-3 whitespace-pre-wrap">{background}</span>
          </Row>
        )}
        <Row label={msg("submit.blackbox.start.target_label")} tip="submit.blackbox.target">
          {targetKind === "text"
            ? msg("submit.blackbox.start.target.text")
            : `${msg("submit.blackbox.start.target.agent")} · ${harness} · ${targetModel.name}`}
        </Row>
        <Row label={msg("submit.blackbox.cases.title")} tip="submit.blackbox.review_cases">
          {parsedCases ? (
            <span>
              {formatMsg("submit.blackbox.cases.loaded", {
                rows: parsedCases.rowCount,
                cols: parsedCases.columns.length,
              })}
              <span className="ms-2 text-xs text-muted-foreground">
                {split.val > 0 || split.test > 0
                  ? formatMsg("submit.blackbox.review.cases_split", {
                      train: Math.round(split.train * 100),
                      val: Math.round(split.val * 100),
                      test: Math.round(split.test * 100),
                    })
                  : msg("submit.blackbox.review.cases_all")}
                {shuffle ? ` · ${msg("submit.blackbox.review.cases_shuffled")}` : ""}
              </span>
            </span>
          ) : (
            msg("submit.blackbox.review.cases_none")
          )}
        </Row>
        <Row label={msg("submit.blackbox.scorer.title")} tip="submit.blackbox.review_scorer">
          {scorerKind === "python" ? (
            scorerModel.name.trim() ? (
              <span>
                {msg("submit.blackbox.scorer.kind.python")} ·{" "}
                <span className="font-mono text-xs" dir="ltr">
                  {scorerModel.name}
                </span>
              </span>
            ) : (
              msg("submit.blackbox.scorer.kind.python")
            )
          ) : (
            <span className="font-mono text-xs" dir="ltr">
              {scorerUrl}
            </span>
          )}
        </Row>
        {scorerKind === "python" && scorerInstall.trim() !== "" && (
          <Row
            label={msg("submit.blackbox.scorer.install_label")}
            tip="submit.blackbox.scorer_install"
          >
            <span className="font-mono text-xs" dir="ltr">
              {scorerInstall.trim()}
            </span>
          </Row>
        )}
        <Row label={msg("submit.blackbox.review.strategy")} tip="submit.blackbox.strategy">
          {strategyMode === "auto"
            ? msg("submit.blackbox.strategy.auto")
            : strategyMode === "plateau"
              ? formatMsg("submit.blackbox.review.strategy_plateau", { n: patience })
              : (selectedEngine?.label ?? msg("submit.blackbox.strategy.single"))}
        </Row>
        <Row label={msg("submit.blackbox.review.budget")} tip="submit.blackbox.budget">
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
        <Row label={TERMS.reflectionModel} tip="blackbox.config.reflection_model">
          <span className="font-mono text-xs" dir="ltr">
            {reflectionModel.name}
          </span>
        </Row>
        <Row label={msg("submit.cost_ceiling.label")} tip="submit.cost_ceiling">
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
        <Row label={msg("submit.basics.privacy.label")} tip="submit.privacy">
          {msg(isPrivate ? "submit.basics.privacy.private" : "submit.basics.privacy.public")}
        </Row>
      </dl>
    </StepCard>
  );
}
