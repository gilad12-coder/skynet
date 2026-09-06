"use client";

import type { ReactNode } from "react";
import { Warning } from "@/shared/ui/icons";
import { Badge } from "@/shared/ui/primitives/badge";
import { HelpTip } from "@/shared/ui/help-tip";
import { formatCredits } from "@/features/billing";
import { harnessLabel } from "@/shared/lib/blackbox-harness";
import { formatMsg, msg } from "@/shared/lib/messages";
import { tip as tipText, type TooltipKey } from "@/shared/lib/tooltips";
import { getActiveIntlLocale } from "@/shared/lib/runtime-locale";
import { TERMS } from "@/shared/lib/terms";

import type { BlackboxWizardContext } from "../../hooks/use-blackbox-wizard";
import { chargeableBracket } from "../../lib/cost-bracket";
import { focusField } from "../../lib/focus-field";
import { OPTIMIZATION_MODEL_DESCRIPTION } from "../../lib/model-roles";
import { WIZARD_STAGE, type WizardStageId } from "../../lib/wizard-steps";
import { formatBudgetAmount } from "@/shared/lib/format-budget-amount";
import { StepCard } from "./shared";

function Row({
  label,
  tip,
  onEdit,
  children,
}: {
  label: ReactNode;
  tip?: TooltipKey;
  onEdit?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-start sm:gap-4">
      <dt className="shrink-0 text-xs font-medium text-muted-foreground sm:w-36">
        {tip ? <HelpTip text={tipText(tip)}>{label}</HelpTip> : label}
      </dt>
      <dd className="min-w-0 flex-1 text-sm text-foreground" dir="auto">
        {children}
      </dd>
      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          className="min-h-[44px] shrink-0 self-start text-xs font-medium text-primary underline-offset-2 hover:underline lg:min-h-0"
        >
          {msg("submit.blackbox.review.edit")}
        </button>
      )}
    </div>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return (
    <span className="font-mono text-xs" dir="ltr">
      {children}
    </span>
  );
}

/**
 * Everything the run will be submitted with, read from the same values the
 * payload is built from. Each row links back to the stage and field that
 * owns it; nothing here is edited in place except the name, description and
 * privacy just above.
 */
export function BlackboxReviewStep({
  w,
  onEditField,
}: {
  w: BlackboxWizardContext;
  onEditField?: (stage: WizardStageId, field?: string) => void;
}) {
  const {
    goTo,
    jobName,
    suggestedName,
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
    scorerUsesModel,
    scorerModelMode,
    resolvedScorerModel,
    scorerInstall,
    strategyMode,
    selectedEngine,
    autoEngineLabels,
    runDisabledReason,
    nativeProposer,
    iterationLimitSupported,
    patience,
    maxScorerRuns,
    maxIterations,
    stopAtScore,
    reflectionModel,
    optimizationFamily,
    costBracket,
    tokenSource,
    maxCostCredits,
  } = w;
  const locale = getActiveIntlLocale();
  const bracket = chargeableBracket(costBracket, tokenSource);
  const credits = (value: number) => `\u2066${formatCredits(value, locale)}\u2069`;

  const edit = (stage: WizardStageId, field?: string) => () => {
    if (onEditField) {
      onEditField(stage, field);
      return;
    }
    goTo(WIZARD_STAGE[stage]);
    if (field) focusField(field);
  };

  const startSummary =
    seedMode === "none" || (seedMode === "text" && !seedText.trim())
      ? msg("submit.blackbox.review.start_none")
      : seedMode === "text"
        ? formatMsg("submit.blackbox.review.start_text", { chars: seedText.length })
        : formatMsg("submit.blackbox.review.start_parts", {
            n: seedParts.filter((p) => p.value.trim()).length,
          });

  const displayName = jobName.trim() || suggestedName;
  const notChosen = msg("submit.blackbox.roles.not_chosen");

  return (
    <StepCard title={msg("auto.features.submit.constants.literal.4")}>
      <dl className="divide-y divide-border/40">
        {displayName && (
          <Row
            label={
              <>
                {msg("auto.features.submit.components.steps.basicsstep.3")}
                {TERMS.optimization}
              </>
            }
            tip="submit.name"
          >
            {displayName}
            {!jobName.trim() && (
              <span className="ms-2 text-xs text-muted-foreground">
                {msg("submit.blackbox.review.name_suggested")}
              </span>
            )}
          </Row>
        )}
        <Row
          label={msg("submit.blackbox.review.start")}
          tip="submit.blackbox.review_start"
          onEdit={edit("goal", "bb-seed")}
        >
          {startSummary}
        </Row>
        {objective.trim() && (
          <Row
            label={msg("submit.blackbox.start.objective_label")}
            tip="submit.blackbox.objective"
            onEdit={edit("goal", "bb-objective")}
          >
            <span className="line-clamp-3 whitespace-pre-wrap">{objective}</span>
          </Row>
        )}
        {background.trim() && (
          <Row
            label={msg("submit.blackbox.start.background_label")}
            tip="submit.blackbox.background"
            onEdit={edit("goal", "bb-background")}
          >
            <span className="line-clamp-3 whitespace-pre-wrap">{background}</span>
          </Row>
        )}
        <Row
          label={msg("submit.blackbox.cases.title")}
          tip="submit.blackbox.review_cases"
          onEdit={edit("evaluation", "bb-cases")}
        >
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
        <Row
          label={msg("submit.blackbox.scorer.title")}
          tip="submit.blackbox.review_scorer"
          onEdit={edit("evaluation", scorerKind === "python" ? "bb-scorer-code" : "bb-scorer-url")}
        >
          {scorerKind === "python" ? (
            msg("submit.blackbox.scorer.kind.python")
          ) : (
            <Mono>{scorerUrl}</Mono>
          )}
        </Row>
        {scorerKind === "python" && scorerInstall.trim() !== "" && (
          <Row
            label={msg("submit.blackbox.scorer.install_label")}
            tip="submit.blackbox.scorer_install"
          >
            <Mono>{scorerInstall.trim()}</Mono>
          </Row>
        )}
        {targetKind === "agent" && (
          <Row label={msg("submit.blackbox.review.execution")}>{harnessLabel(harness)}</Row>
        )}
        <Row
          label={msg("submit.blackbox.review.models")}
          tip="submit.blackbox.roles"
          onEdit={edit("optimization", "bb-optimization-model")}
        >
          <ul className="space-y-1.5">
            {targetKind === "agent" && (
              <li>
                <span className="font-medium">{msg("submit.blackbox.roles.task.label")}</span>
                {" · "}
                {targetModel.name.trim() ? <Mono>{targetModel.name}</Mono> : notChosen}
                <span className="block text-xs text-muted-foreground">
                  {msg("submit.blackbox.roles.task.desc")}
                </span>
              </li>
            )}
            <li>
              <span className="font-medium">{msg("submit.blackbox.roles.optimization.label")}</span>
              {" · "}
              {reflectionModel.name.trim() ? <Mono>{reflectionModel.name}</Mono> : notChosen}
              <span className="block text-xs text-muted-foreground">
                {msg(OPTIMIZATION_MODEL_DESCRIPTION[optimizationFamily])}
              </span>
            </li>
            <li>
              {scorerUsesModel ? (
                <>
                  <span className="font-medium">{msg("submit.blackbox.roles.scoring.label")}</span>
                  {" · "}
                  {resolvedScorerModel?.name.trim() ? (
                    <Mono>{resolvedScorerModel.name}</Mono>
                  ) : (
                    notChosen
                  )}
                  {" · "}
                  {msg(
                    scorerModelMode === "inherit"
                      ? "submit.blackbox.roles.scoring.inherited"
                      : "submit.blackbox.roles.scoring.custom",
                  )}
                  <span className="block text-xs text-muted-foreground">
                    {msg(
                      scorerModelMode === "inherit"
                        ? "submit.blackbox.roles.scoring.inherited_desc"
                        : "submit.blackbox.roles.scoring.custom_desc",
                    )}
                  </span>
                </>
              ) : (
                <>
                  <span className="font-medium">
                    {msg("submit.blackbox.roles.scoring.deterministic_label")}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {msg("submit.blackbox.roles.scoring.deterministic_desc")}
                  </span>
                </>
              )}
            </li>
          </ul>
        </Row>
        <Row
          label={msg("submit.blackbox.review.strategy")}
          tip="submit.blackbox.strategy"
          onEdit={edit("optimization", "bb-engines")}
        >
          {strategyMode === "auto"
            ? msg("submit.blackbox.strategy.auto")
            : strategyMode === "plateau"
              ? formatMsg("submit.blackbox.review.strategy_plateau", { n: patience })
              : (selectedEngine?.label ?? msg("submit.blackbox.strategy.single"))}
          {strategyMode !== "single" && autoEngineLabels.length > 0 && (
            <span className="ms-2 text-xs text-muted-foreground">
              {formatMsg("submit.blackbox.engines.auto_can_run", {
                engines: autoEngineLabels.join(" · "),
              })}
            </span>
          )}
          {runDisabledReason && (
            <span className="mt-1 flex items-start gap-1.5 text-xs text-amber-700" role="status">
              <Warning className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>{runDisabledReason}</span>
            </span>
          )}
        </Row>
        <Row
          label={msg("submit.blackbox.review.budget")}
          tip="submit.blackbox.budget"
          onEdit={edit("optimization", "bb-max-runs")}
        >
          <span className="flex flex-wrap gap-1.5">
            <Badge variant="outline">
              {formatMsg("submit.blackbox.review.budget_runs", { runs: maxScorerRuns })}
            </Badge>
            {iterationLimitSupported && maxIterations !== "" && (
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
        <Row
          label={msg("submit.budget.label")}
          tip="submit.budget"
          onEdit={edit("evaluation", "totalBudgetInput")}
        >
          {maxCostCredits != null ? credits(maxCostCredits) : msg("submit.budget.unset_short")}
          <span className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
            <span>
              {formatMsg("submit.budget.estimated_range", {
                low: credits(bracket.lowCredits),
                high: credits(bracket.highCredits),
              })}
            </span>
            {w.budgetSession.budget &&
              (
                [
                  ["submit.budget.setup_spent", w.budgetSession.budget.setup_spent_credits],
                  ["submit.budget.run_spent", w.budgetSession.budget.run_spent_credits],
                  ["submit.budget.reserved", w.budgetSession.budget.reserved_credits],
                  ["submit.budget.available", w.budgetSession.budget.available_credits],
                ] as const
              ).map(([label, amount]) => (
                <span key={label}>
                  {msg(label)}: {formatBudgetAmount(amount, locale)}
                </span>
              ))}
          </span>
        </Row>
        <Row label={msg("submit.budget.billing_source")}>
          {msg(tokenSource === "byok" ? "billing.mode.byok" : "billing.mode.managed")}
          <span className="block text-xs text-muted-foreground">
            {msg(tokenSource === "byok" ? "billing.mode.byok_hint" : "billing.mode.managed_hint")}
          </span>
        </Row>
        <Row label={msg("submit.basics.privacy.label")} tip="submit.privacy">
          {msg(isPrivate ? "submit.basics.privacy.private" : "submit.basics.privacy.public")}
        </Row>
      </dl>
    </StepCard>
  );
}
