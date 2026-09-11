"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";

import { ValidationFrame, ValidationGate, ValidationPlan } from "./ValidationFrame";
import { msg } from "@/shared/lib/messages";
import { useCredits } from "@/features/billing";

import { TotalBudgetCard } from "./TotalBudgetCard";
import { WizardIssueNotice } from "./WizardIssueNotice";
import { WizardSubsteps } from "./WizardSubsteps";
import { aggregateTokenSource } from "../lib/cost-bracket";
import { useSubmitWizard } from "../hooks/use-submit-wizard";
import { emptyModelConfig, slideVariants } from "../constants";
import { budgetShortfall } from "../lib/budget-limit";
import { toastBudgetShortfall } from "../lib/budget-toast";
import { focusField } from "../lib/focus-field";
import { WIZARD_STAGE, stageAt, type WizardStageId } from "../lib/wizard-steps";
import { SubmitStepper } from "./SubmitStepper";
import { SubmitNav } from "./SubmitNav";
import { SubmitSplash } from "./SubmitSplash";
import { ModelConfigModal } from "./ModelConfigModal";
import { BasicsStep } from "./steps/BasicsStep";
import { DatasetStep } from "./steps/DatasetStep";
import { ModelStep } from "./steps/ModelStep";
import { CodeStep } from "./steps/CodeStep";
import { ParamsStep } from "./steps/ParamsStep";
import { SummaryStep } from "./steps/SummaryStep";
import { SplitSection } from "./steps/SplitSection";

const EVALUATION_STEPS = ["dataset", "code", "split"] as const;
const OPTIMIZATION_STEPS = ["parameters", "models", "budget", "check"] as const;
const REVIEW_STEPS = ["review"] as const;
const CODE_FIELDS = new Set(["signature-editor", "metric-editor", "react-config"]);

/** The evaluation substep that holds a field, so a problem opens where it is fixed. */
function evaluationPartFor(field?: string): number | null {
  if (!field) return null;
  if (CODE_FIELDS.has(field)) return 1;
  if (field === "data-splits") return 2;
  return 0;
}

export function SubmitWizard({ header }: { header?: ReactNode }) {
  const w = useSubmitWizard();
  const wallet = useCredits();
  const [dataPreviewOpen, setDataPreviewOpen] = useState(false);
  const [dataPreviewExpanded, setDataPreviewExpanded] = useState(false);
  const [evaluationPart, setEvaluationPart] = useState(0);
  const [optimizationPart, setOptimizationPart] = useState(0);

  const routeSubstep = useCallback((stage: WizardStageId, field?: string) => {
    if (stage === "evaluation") {
      const part = evaluationPartFor(field);
      if (part != null) setEvaluationPart(part);
    }
    if (stage === "optimization")
      setOptimizationPart(field === "totalBudgetInput" ? 2 : field === "model-catalog" ? 1 : 0);
  }, []);
  const goToField = (stage: WizardStageId, field?: string) => {
    // Budget errors return to the last configuration panel.
    const target: WizardStageId = field === "totalBudgetInput" ? "optimization" : stage;
    routeSubstep(target, field);
    w.goTo(WIZARD_STAGE[target]);
    if (field) focusField(field);
  };
  // A reported problem opens the substep that holds its field and lands focus there.
  useEffect(() => {
    if (!w.issue) return;
    routeSubstep(w.issue.stage, w.issue.fieldId);
    if (w.issue.fieldId) focusField(w.issue.fieldId);
  }, [w.issue, routeSubstep]);

  const stage = stageAt(w.step);
  // Validation problems stay live: they follow the stage's current state until
  // it validates. Setup-check problems hold until the checked setup changes.
  const issue =
    w.issue && w.issue.stage === stage
      ? w.issue.identity
        ? w.preflight.identity === w.issue.identity
          ? w.issue
          : null
        : w.stageIssue(w.step, true)
      : null;

  const budgetMode = aggregateTokenSource(
    w.jobType === "grid_search"
      ? [...w.generationModels, ...w.reflectionModels]
      : [
          w.modelConfig,
          ...(w.optimizerName === "gepa" && w.secondModelConfig ? [w.secondModelConfig] : []),
        ],
  );
  const evaluationPanels: readonly ReactNode[] = [
    <DatasetStep
      key="dataset"
      w={w}
      previewOpen={dataPreviewOpen}
      onPreviewOpenChange={setDataPreviewOpen}
      previewExpanded={dataPreviewExpanded}
      onPreviewExpandedChange={setDataPreviewExpanded}
    />,
    <CodeStep key="code" w={w} part="code" />,
    <SplitSection key="split" w={w} totalRows={w.parsedDataset?.rowCount ?? 0} />,
  ];
  // The stage ends on its check: the last pass for this setup, or what
  // Continue will run.
  const executionResult = w.preflight.progress.completed("execution");
  const priorExecution = w.preflight.evidence.execution;
  const optimizationPanels: readonly ReactNode[] = [
    <ParamsStep key="parameters" w={w} />,
    <ModelStep key="models" w={w} />,
    <TotalBudgetCard key="budget" w={w} mode={budgetMode} />,
    executionResult ? (
      <ValidationFrame key="check" state={executionResult} settled />
    ) : (
      <ValidationPlan
        key="check"
        workflow="dspy"
        scope="execution"
        stale={priorExecution !== undefined && priorExecution.identity !== w.preflight.identity}
      />
    ),
  ];
  const validation = w.preflight.progress.state;
  // A passed check is shown on its own page, the last optimization substep,
  // which is where the stage reopens afterwards.
  const passedCheck = validation?.status === "succeeded";
  useEffect(() => {
    if (passedCheck) setOptimizationPart(OPTIMIZATION_STEPS.length - 1);
  }, [passedCheck]);
  // A check that passed from its own stage is a page of its own: it stays,
  // with the navigation, until the user moves on.
  const held = validation?.status === "succeeded" && w.step === WIZARD_STAGE.optimization;
  const onCheckPage =
    w.step === WIZARD_STAGE.optimization && OPTIMIZATION_STEPS[optimizationPart] === "check";

  const handleEvaluationNext = async () => {
    if (evaluationPart < EVALUATION_STEPS.length - 1) {
      setEvaluationPart((current) => current + 1);
      return;
    }
    await w.handleNext();
  };

  const shortfall = budgetShortfall(w.costBracket, budgetMode, {
    uncapped: w.budgetUncapped,
    limit: w.maxCostCredits,
    balance: wallet.available ? wallet.totalCredits : null,
  });
  const handleOptimizationNext = async () => {
    if (OPTIMIZATION_STEPS[optimizationPart] === "budget" && shortfall) {
      toastBudgetShortfall(shortfall);
      return;
    }
    const next = OPTIMIZATION_STEPS[optimizationPart + 1];
    // The check page opens on the last pass; without one, Continue runs the
    // check, which holds the wizard there.
    if (next === "check" && !executionResult) {
      await w.handleNext();
      return;
    }
    if (next) {
      setOptimizationPart((current) => current + 1);
      return;
    }
    await w.handleNext();
  };

  const stageViews: Record<WizardStageId, ReactNode> = {
    goal: <CodeStep w={w} part="module" header={header} />,
    evaluation: (
      <WizardSubsteps
        active={evaluationPart}
        ariaLabel={msg("submit.stage.evaluation")}
        steps={EVALUATION_STEPS}
      >
        {evaluationPanels[evaluationPart]}
      </WizardSubsteps>
    ),
    optimization: (
      <WizardSubsteps
        active={optimizationPart}
        ariaLabel={msg("submit.stage.optimization")}
        steps={OPTIMIZATION_STEPS}
      >
        {optimizationPanels[optimizationPart]}
      </WizardSubsteps>
    ),
    review: (
      <WizardSubsteps active={0} ariaLabel={msg("submit.stage.review")} steps={REVIEW_STEPS}>
        <div className="space-y-4 md:space-y-6">
          <BasicsStep w={w} />
          <SummaryStep
            w={w}
            onEditStage={(target) => {
              if (target === "evaluation") setEvaluationPart(0);
              if (target === "optimization") setOptimizationPart(0);
              w.goTo(WIZARD_STAGE[target]);
            }}
          />
        </div>
      </WizardSubsteps>
    ),
  };

  const onBack = () => {
    // Leaving a held result settles it into its page.
    if (held) w.preflight.progress.clear();
    if (w.step === WIZARD_STAGE.evaluation && evaluationPart > 0) {
      setEvaluationPart((current) => current - 1);
      return;
    }
    if (w.step === WIZARD_STAGE.optimization && optimizationPart > 0) {
      setOptimizationPart((current) => current - 1);
      return;
    }
    if (w.step === WIZARD_STAGE.review) setOptimizationPart(OPTIMIZATION_STEPS.length - 1);
    w.goPrev();
  };
  const onNext =
    w.step === WIZARD_STAGE.evaluation
      ? handleEvaluationNext
      : w.step === WIZARD_STAGE.optimization
        ? handleOptimizationNext
        : w.handleNext;
  const showSubmit = w.step === WIZARD_STAGE.review;
  const containerWidthClass =
    validation || onCheckPage
      ? "max-w-3xl"
      : w.step === WIZARD_STAGE.evaluation &&
          ((evaluationPart === 1 && w.codeAssistMode === "auto") ||
            (evaluationPart === 0 && dataPreviewOpen && dataPreviewExpanded && !!w.parsedDataset))
        ? "max-w-6xl"
        : "max-w-2xl";

  return (
    <div
      className={`mx-auto w-full min-w-0 space-y-4 pb-6 transition-[max-width] duration-300 md:-mt-4 md:space-y-6 md:pb-8 ${containerWidthClass}`}
    >
      <SubmitStepper w={w} locked={validation !== null && !held} />

      <div className="relative overflow-hidden pt-[10px]" data-tutorial="submit-wizard">
        <ValidationGate
          validation={validation}
          direction={w.direction}
          hold={held}
          onBack={w.preflight.progress.clear}
        >
          <AnimatePresence mode="wait" custom={w.direction}>
            <motion.div
              key={w.step}
              data-tutorial={`wizard-stage-${stage}`}
              custom={w.direction}
              variants={slideVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.1 }}
            >
              {issue && (
                <WizardIssueNotice
                  issue={issue}
                  onFix={() => goToField(issue.stage, issue.fieldId)}
                />
              )}
              {stageViews[stage]}
            </motion.div>
          </AnimatePresence>
        </ValidationGate>
      </div>

      {(validation === null || held) && (
        <SubmitNav
          w={w}
          onBack={onBack}
          onNext={onNext}
          backDisabled={w.step === WIZARD_STAGE.goal}
          showSubmit={showSubmit}
        />
      )}

      <ModelConfigModal
        open={!!w.editingModel}
        onOpenChange={(open) => {
          if (!open) w.setEditingModel(null);
        }}
        config={w.editingModel?.config ?? emptyModelConfig()}
        onSave={(config) => {
          w.editingModel?.onSave(config);
          w.saveToRecent(config);
          w.setEditingModel(null);
        }}
        roleLabel={w.editingModel?.label ?? msg("model.generation.label")}
        catalogModels={w.catalog?.models}
        recentConfigs={w.recentConfigs}
        onRemoveRecent={w.removeRecentConfig}
      />

      <SubmitSplash w={w} />
    </div>
  );
}
