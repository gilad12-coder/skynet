"use client";

import { useEffect, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "react-toastify";

import { msg } from "@/shared/lib/messages";

import { PreflightChecks } from "./PreflightChecks";
import { TotalBudgetCard } from "./TotalBudgetCard";
import { WizardSubsteps } from "./WizardSubsteps";
import { aggregateTokenSource } from "../lib/cost-bracket";
import { useSubmitWizard } from "../hooks/use-submit-wizard";
import { emptyModelConfig, slideVariants } from "../constants";
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

const REVIEW_STEPS = ["details", "summary"] as const;

export function SubmitWizard({ header }: { header?: ReactNode }) {
  const w = useSubmitWizard();
  const [evaluationPart, setEvaluationPart] = useState(0);
  const [optimizationPart, setOptimizationPart] = useState(0);
  const [reviewPart, setReviewPart] = useState(0);

  const evaluationSteps = ["budget", "dataset", "code", "split", "checks"] as const;
  const optimizationSteps = ["parameters", "models", "checks"] as const;

  // A clone lands on the summary: its details are cloned too.
  useEffect(() => {
    if (w.cloned) setReviewPart(REVIEW_STEPS.length - 1);
  }, [w.cloned]);

  const budgetMode = aggregateTokenSource(
    w.jobType === "grid_search"
      ? [...w.generationModels, ...w.reflectionModels]
      : [
          w.modelConfig,
          ...(w.optimizerName === "gepa" && w.secondModelConfig ? [w.secondModelConfig] : []),
        ],
  );
  const evaluationPanels: readonly ReactNode[] = [
    <TotalBudgetCard key="budget" w={w} mode={budgetMode} />,
    <DatasetStep key="dataset" w={w} />,
    <CodeStep key="code" w={w} part="code" />,
    <SplitSection key="split" w={w} />,
    <PreflightChecks key="checks" preflight={w.preflight} scope="evaluation" />,
  ];
  const optimizationPanels: readonly ReactNode[] = [
    <ParamsStep key="parameters" w={w} />,
    <ModelStep key="models" w={w} />,
    <PreflightChecks key="checks" preflight={w.preflight} scope="execution" />,
  ];
  const reviewPanels: readonly ReactNode[] = [
    <BasicsStep key="details" w={w} />,
    <SummaryStep
      key="summary"
      w={w}
      onEditStage={(stage) => {
        if (stage === "evaluation") setEvaluationPart(0);
        if (stage === "optimization") setOptimizationPart(0);
        w.goTo(WIZARD_STAGE[stage]);
      }}
    />,
  ];

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
    if (!w.parsedDataset?.rowCount) {
      setEvaluationPart(1);
      toast.error(msg("submit.validation.dataset_required"));
      return;
    }
    if (!Object.values(w.columnRoles).includes("input")) {
      setEvaluationPart(1);
      toast.error(msg("submit.validation.input_column_required"));
      return;
    }
    if (!Object.values(w.columnRoles).includes("output")) {
      setEvaluationPart(1);
      toast.error(msg("submit.validation.output_column_required"));
      return;
    }
    if (!w.validateStep(WIZARD_STAGE.evaluation, true, true)) {
      setEvaluationPart(2);
      return;
    }
    if (w.splitSum !== 1) {
      setEvaluationPart(3);
      toast.error(msg("submit.validation.split_must_sum_to_one"));
      return;
    }
    await w.handleNext();
  };

  const handleOptimizationNext = async () => {
    if (optimizationPart < optimizationSteps.length - 1) {
      setOptimizationPart((current) => current + 1);
      return;
    }
    if (!w.validateStep(WIZARD_STAGE.optimization, true)) {
      const modelMissing =
        w.jobType === "run"
          ? !w.modelConfig.name.trim() ||
            (w.optimizerName.toLowerCase() === "gepa" && !w.secondModelConfig?.name?.trim())
          : w.generationModels.every((model) => !model.name.trim()) ||
            w.reflectionModels.every((model) => !model.name.trim());
      setOptimizationPart(modelMissing ? 1 : w.runtimeUnavailableReason ? 2 : 0);
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
        steps={REVIEW_STEPS}
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
    w.step === WIZARD_STAGE.evaluation
      ? handleEvaluationNext
      : w.step === WIZARD_STAGE.optimization
        ? handleOptimizationNext
        : w.step === WIZARD_STAGE.review && reviewPart < REVIEW_STEPS.length - 1
          ? () => setReviewPart((current) => current + 1)
          : w.handleNext;
  const onSubmit = () => {
    if (!w.jobName.trim()) {
      setReviewPart(0);
      toast.error(msg("submit.validation.name_required"));
      return;
    }
    void w.handleSubmit();
  };
  const showSubmit = w.step === WIZARD_STAGE.review && reviewPart === REVIEW_STEPS.length - 1;
  const containerWidthClass =
    w.step === WIZARD_STAGE.evaluation && evaluationPart === 2 && w.codeAssistMode === "auto"
      ? "max-w-6xl"
      : "max-w-2xl";

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
        onSubmit={onSubmit}
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
        roleLabel={w.editingModel?.label ?? msg("model.generation.label")}
        catalogModels={w.catalog?.models}
        recentConfigs={w.recentConfigs}
        onRemoveRecent={w.removeRecentConfig}
      />

      <SubmitSplash w={w} />
    </div>
  );
}
