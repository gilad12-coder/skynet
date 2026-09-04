"use client";

import { useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "react-toastify";

import { msg } from "@/shared/lib/messages";
import { SubmitSplashOverlay } from "@/shared/ui/submit-splash-overlay";
import { TERMS } from "@/shared/lib/terms";

import { useBlackboxWizard, type BlackboxRecipe } from "../../hooks/use-blackbox-wizard";
import { emptyModelConfig, slideVariants } from "../../constants";
import { focusField } from "../../lib/focus-field";
import { WIZARD_STAGE, stageAt, type WizardStageId } from "../../lib/wizard-steps";
import { SubmitStepper } from "../SubmitStepper";
import { SubmitNav } from "../SubmitNav";
import { ModelConfigModal } from "../ModelConfigModal";
import { PreflightChecks } from "../PreflightChecks";
import { TotalBudgetCard } from "../TotalBudgetCard";
import { WizardSubsteps } from "../WizardSubsteps";
import { SplitSection } from "../steps/SplitSection";
import { BlackboxBasicsStep } from "./BlackboxBasicsStep";
import { BlackboxStartStep } from "./BlackboxStartStep";
import { BlackboxCasesStep } from "./BlackboxCasesStep";
import { BlackboxScorerStep } from "./BlackboxScorerStep";
import { BlackboxExecutionSection } from "./BlackboxExecutionSection";
import { BlackboxOptimizerStep } from "./BlackboxOptimizerStep";
import { BlackboxReviewStep } from "./BlackboxReviewStep";

export function BlackboxWizard({
  header,
  initialRecipe,
}: {
  header?: ReactNode;
  initialRecipe: BlackboxRecipe;
}) {
  const w = useBlackboxWizard(initialRecipe);
  const [evaluationPart, setEvaluationPart] = useState(0);
  const [optimizationPart, setOptimizationPart] = useState(0);
  const [reviewPart, setReviewPart] = useState(0);

  const goalSteps = ["goal"] as const;
  const evaluationSteps = ["budget", "cases", "scorer", "execution", "split", "checks"] as const;
  const optimizationSteps = ["strategy", "model", "limits", "checks"] as const;
  const reviewSteps = ["details", "summary"] as const;

  const goalPanels: readonly ReactNode[] = [<BlackboxStartStep key="goal" w={w} header={header} />];
  const evaluationPanels: readonly ReactNode[] = [
    <TotalBudgetCard key="budget" w={w} mode={w.tokenSource} />,
    <div key="cases" id="bb-cases" tabIndex={-1} className="outline-none">
      <BlackboxCasesStep w={w} />
    </div>,
    <BlackboxScorerStep key="scorer" w={w} />,
    <BlackboxExecutionSection key="execution" w={w} />,
    <div key="split" id="bb-split" tabIndex={-1} className="outline-none">
      <SplitSection w={w} />
    </div>,
    <PreflightChecks key="checks" preflight={w.preflight} scope="evaluation" />,
  ];
  const optimizationPanels: readonly ReactNode[] = [
    <BlackboxOptimizerStep key="strategy" w={w} part="strategy" />,
    <BlackboxOptimizerStep key="model" w={w} part="model" />,
    <BlackboxOptimizerStep key="limits" w={w} part="limits" />,
    <PreflightChecks key="checks" preflight={w.preflight} scope="execution" />,
  ];
  const handleEditField = (stage: WizardStageId, field?: string) => {
    if (stage === "evaluation") {
      if (field === "totalBudgetInput") setEvaluationPart(0);
      else if (field === "bb-cases") setEvaluationPart(1);
      else if (field?.startsWith("bb-scorer")) setEvaluationPart(2);
      else if (field === "bb-execution-agent" || field === "bb-task-model") setEvaluationPart(3);
      else if (field === "bb-split") setEvaluationPart(4);
      else setEvaluationPart(5);
    }
    if (stage === "optimization") {
      if (field === "bb-optimization-model") setOptimizationPart(1);
      else if (field === "bb-max-runs") setOptimizationPart(2);
      else setOptimizationPart(0);
    }
    w.goTo(WIZARD_STAGE[stage]);
    if (field) window.setTimeout(() => focusField(field), 0);
  };
  const reviewPanels: readonly ReactNode[] = [
    <BlackboxBasicsStep key="details" w={w} />,
    <BlackboxReviewStep key="summary" w={w} onEditField={handleEditField} />,
  ];

  const handleGoalNext = async () => {
    if (!w.validateStep(WIZARD_STAGE.goal, true)) return;
    await w.handleNext();
  };

  const handleEvaluationNext = async () => {
    if (evaluationPart < evaluationSteps.length - 1) {
      setEvaluationPart((current) => current + 1);
      return;
    }
    if (w.maxCostCredits == null) {
      setEvaluationPart(0);
      toast.error(msg("budget.invalid"));
      return;
    }
    if (w.targetKind === "agent" && !w.parsedCases?.rowCount) {
      setEvaluationPart(1);
    } else if (w.targetKind === "agent" && !w.targetModel.name.trim()) {
      setEvaluationPart(3);
    } else if (
      (w.scorerKind === "python" && !w.metricCode.trim()) ||
      (w.scorerUsesModel && w.scorerModelMode === "explicit" && !w.scorerModel.name.trim()) ||
      (w.scorerKind === "remote" && !/^https?:\/\/\S+$/.test(w.scorerUrl.trim()))
    ) {
      setEvaluationPart(2);
    } else if (w.parsedCases && w.splitSum !== 1) {
      setEvaluationPart(4);
    }
    if (!w.validateStep(WIZARD_STAGE.evaluation, true)) return;
    await w.handleNext();
  };

  const handleOptimizationNext = async () => {
    if (optimizationPart < optimizationSteps.length - 1) {
      setOptimizationPart((current) => current + 1);
      return;
    }
    if (!w.validateStep(WIZARD_STAGE.optimization, true)) {
      const missingTrainingCases =
        (!w.parsedCases?.rowCount || w.split.train === 0) &&
        (w.strategyMode !== "single" || w.engine === "meta_harness");
      if (missingTrainingCases) {
        setEvaluationPart(1);
        w.goTo(WIZARD_STAGE.evaluation);
        return;
      }
      const modelIssue = !w.reflectionModel.name.trim();
      setOptimizationPart(modelIssue ? 1 : w.maxCostCredits == null ? 2 : 0);
      return;
    }
    await w.handleNext();
  };

  const stageViews: Record<WizardStageId, ReactNode> = {
    goal: (
      <WizardSubsteps active={0} ariaLabel={msg("submit.stage.goal")} steps={goalSteps}>
        {goalPanels[0]}
      </WizardSubsteps>
    ),
    evaluation: (
      <WizardSubsteps
        active={evaluationPart}
        ariaLabel={msg("submit.stage.evaluation")}
        steps={evaluationSteps}
      >
        {evaluationPanels[evaluationPart]}
      </WizardSubsteps>
    ),
    optimization: (
      <WizardSubsteps
        active={optimizationPart}
        ariaLabel={msg("submit.stage.optimization")}
        steps={optimizationSteps}
      >
        {optimizationPanels[optimizationPart]}
      </WizardSubsteps>
    ),
    review: (
      <WizardSubsteps
        active={reviewPart}
        ariaLabel={msg("submit.stage.review")}
        steps={reviewSteps}
      >
        {reviewPanels[reviewPart]}
      </WizardSubsteps>
    ),
  };

  const onBack = () => {
    if (w.step === WIZARD_STAGE.evaluation && evaluationPart > 0) {
      setEvaluationPart((current) => current - 1);
      return;
    }
    if (w.step === WIZARD_STAGE.optimization && optimizationPart > 0) {
      setOptimizationPart((current) => current - 1);
      return;
    }
    if (w.step === WIZARD_STAGE.review && reviewPart > 0) {
      setReviewPart((current) => current - 1);
      return;
    }
    w.goPrev();
  };
  const onNext =
    w.step === WIZARD_STAGE.goal
      ? handleGoalNext
      : w.step === WIZARD_STAGE.evaluation
        ? handleEvaluationNext
        : w.step === WIZARD_STAGE.optimization
          ? handleOptimizationNext
          : w.step === WIZARD_STAGE.review && reviewPart < reviewSteps.length - 1
            ? () => setReviewPart((current) => current + 1)
            : w.handleNext;
  const showSubmit = w.step === WIZARD_STAGE.review && reviewPart === reviewSteps.length - 1;
  // Auto mode seats the agent pane beside the form on the Goal stage and the
  // scorer, so those take the wide column; plain forms keep the narrow one.
  const wideAuthoringPanel =
    w.codeAssistMode === "auto" &&
    (w.step === WIZARD_STAGE.goal || (w.step === WIZARD_STAGE.evaluation && evaluationPart === 2));
  const containerWidthClass = wideAuthoringPanel ? "max-w-6xl" : "max-w-2xl";

  return (
    <div
      className={`mx-auto w-full min-w-0 space-y-4 pb-6 transition-[max-width] duration-300 md:-mt-4 md:space-y-6 md:pb-8 ${containerWidthClass}`}
    >
      <SubmitStepper w={w} />

      <div className="relative overflow-hidden pt-[10px]" data-tutorial="submit-wizard">
        <AnimatePresence mode="wait" custom={w.direction}>
          <motion.div
            key={w.step}
            data-tutorial={`wizard-stage-${stageAt(w.step)}`}
            custom={w.direction}
            variants={slideVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ duration: 0.1 }}
          >
            {stageViews[stageAt(w.step)]}
          </motion.div>
        </AnimatePresence>
      </div>

      <SubmitNav
        w={w}
        onBack={onBack}
        onNext={onNext}
        backDisabled={w.step === WIZARD_STAGE.goal}
        showSubmit={showSubmit}
      />

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
        roleLabel={w.editingModel?.label ?? TERMS.reflectionModel}
        catalogModels={w.catalog?.models}
        recentConfigs={w.recentConfigs}
        onRemoveRecent={w.removeRecentConfig}
        nameOnly={w.editingModel?.nameOnly}
        modelDefaultsOnly={w.editingModel?.modelDefaultsOnly}
      />

      <SubmitSplashOverlay show={w.submitPhase === "splash" || w.submitPhase === "done"} />
    </div>
  );
}
