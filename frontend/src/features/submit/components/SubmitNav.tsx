"use client";

import { CaretLeft, CaretRight, CaretDown, CircleNotch } from "@/shared/ui/icons";
import { motion, useReducedMotion } from "framer-motion";
import { Button } from "@/shared/ui/primitives/button";
import { formatCredits } from "@/features/billing";
import { TERMS } from "@/shared/lib/terms";
import { formatMsg, msg } from "@/shared/lib/messages";
import { getActiveDir, getActiveIntlLocale } from "@/shared/lib/runtime-locale";

import { LAST_WIZARD_STAGE } from "../lib/wizard-steps";
import type { SubmitWizardContext } from "../hooks/use-submit-wizard";

type NavContext = Pick<
  SubmitWizardContext,
  | "step"
  | "goPrev"
  | "handleNext"
  | "handleSubmit"
  | "submitting"
  | "advancing"
  | "maxCostCredits"
  | "budgetUncapped"
> & {
  // Why the run cannot start right now (an engine that cannot run here yet);
  // the button stays visible so the reason stays visible with it.
  runDisabledReason?: string | null;
};

interface SubmitNavProps {
  w: NavContext;
  onBack?: () => void;
  onNext?: () => void;
  onSubmit?: () => void;
  backDisabled?: boolean;
  showSubmit?: boolean;
}

export function SubmitNav({
  w,
  onBack,
  onNext,
  onSubmit,
  backDisabled,
  showSubmit,
}: SubmitNavProps) {
  const reducedMotion = useReducedMotion();
  const {
    step,
    goPrev,
    handleNext,
    handleSubmit,
    submitting,
    advancing,
    maxCostCredits,
    budgetUncapped,
  } = w;
  const runDisabledReason = w.runDisabledReason ?? null;

  // Back points toward the start, Next toward the end — the physical direction
  // of each flips with the locale (left/right swap in RTL).
  const rtl = getActiveDir() === "rtl";
  const BackChevron = rtl ? CaretRight : CaretLeft;
  const NextChevron = rtl ? CaretLeft : CaretRight;

  const renderSubmit = showSubmit ?? step >= LAST_WIZARD_STAGE;

  if (!renderSubmit) {
    return (
      <div className="flex items-stretch justify-between gap-3">
        <Button
          onClick={onBack ?? goPrev}
          disabled={(backDisabled ?? step === 0) || advancing}
          className="min-h-[44px] min-w-0 flex-1 gap-2 whitespace-normal sm:flex-none sm:whitespace-nowrap"
        >
          <BackChevron className="h-4 w-4" />
          {msg("auto.features.submit.components.submitnav.1")}
        </Button>
        <Button
          onClick={onNext ?? handleNext}
          disabled={advancing}
          aria-busy={advancing || undefined}
          aria-live="polite"
          className="min-h-[44px] min-w-0 flex-1 justify-center gap-2 whitespace-normal sm:min-w-[88px] sm:flex-none sm:whitespace-nowrap"
          data-tutorial="wizard-next"
        >
          {advancing ? (
            <>
              <CircleNotch
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
              <span>{msg("submit.nav.validating")}</span>
            </>
          ) : (
            <>
              {msg("auto.features.submit.components.submitnav.2")}
              <NextChevron className="h-4 w-4" />
            </>
          )}
        </Button>
      </div>
    );
  }

  return (
    <motion.button
      type="button"
      onClick={onSubmit ?? handleSubmit}
      disabled={submitting || advancing || runDisabledReason !== null}
      aria-busy={submitting || advancing || undefined}
      aria-disabled={runDisabledReason !== null || undefined}
      title={runDisabledReason ?? undefined}
      data-tutorial="submit-button"
      data-telemetry="submit-run"
      animate={runDisabledReason || reducedMotion ? { scale: 1 } : { scale: [1, 1.01, 1] }}
      transition={{ repeat: Infinity, duration: 3, ease: "easeInOut" }}
      className="group relative w-full rounded-2xl bg-primary text-primary-foreground font-semibold text-base pt-5 pb-7 cursor-pointer transition-all duration-300 hover:shadow-[0_0_30px_rgba(61,46,34,0.35)] hover:scale-[1.01] active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed"
    >
      {submitting || advancing ? (
        <span className="flex items-center justify-center gap-2">
          <CircleNotch className="size-5 animate-spin motion-reduce:animate-none" />
          {advancing
            ? msg("submit.nav.validating")
            : msg("auto.features.submit.components.submitnav.3")}
        </span>
      ) : (
        <div className="flex flex-col items-center gap-4">
          <span className="flex flex-col items-center gap-1">
            <span>
              {msg("auto.features.submit.components.submitnav.4")}
              {TERMS.optimization}
            </span>
            {budgetUncapped ? (
              <span className="text-xs font-normal text-primary-foreground/75" dir="auto">
                {msg("submit.budget.uncapped_short")}
              </span>
            ) : (
              maxCostCredits != null && (
                <span className="text-xs font-normal text-primary-foreground/75" dir="auto">
                  {formatMsg("submit.nav.run_cap", {
                    credits: formatCredits(maxCostCredits, getActiveIntlLocale()),
                  })}
                </span>
              )
            )}
            {runDisabledReason && (
              <span className="text-xs font-normal text-primary-foreground/90" dir="auto">
                {runDisabledReason}
              </span>
            )}
          </span>
          <div className="flex flex-col items-center -space-y-7 h-0 overflow-visible opacity-70 group-hover:opacity-100 transition-opacity duration-200 [&>svg]:animate-[cascadeDown_1s_ease-in-out_infinite] group-hover:[&>svg]:animate-[cascadeDownHyper_0.5s_ease-out_infinite] motion-reduce:[&>svg]:animate-none motion-reduce:group-hover:[&>svg]:animate-none">
            <CaretDown className="size-10 [animation-delay:0s] group-hover:[animation-delay:0s]" />
            <CaretDown className="size-10 [animation-delay:0.15s] group-hover:[animation-delay:0.08s]" />
            <CaretDown className="size-10 [animation-delay:0.3s] group-hover:[animation-delay:0.16s]" />
          </div>
        </div>
      )}
    </motion.button>
  );
}
