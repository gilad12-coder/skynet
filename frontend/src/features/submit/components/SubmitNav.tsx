"use client";

import { CaretLeft, CaretRight, CaretDown, CircleNotch } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import { TERMS } from "@/shared/lib/terms";
import { msg } from "@/shared/lib/messages";
import { getActiveDir } from "@/shared/lib/runtime-locale";

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
  const {
    step,
    goPrev,
    handleNext,
    handleSubmit,
    submitting,
    advancing,
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
    <button
      type="button"
      onClick={onSubmit ?? handleSubmit}
      disabled={submitting || advancing || runDisabledReason !== null}
      aria-busy={submitting || advancing || undefined}
      aria-disabled={runDisabledReason !== null || undefined}
      title={runDisabledReason ?? undefined}
      data-tutorial="submit-button"
      data-telemetry="submit-run"
      className="group relative w-full cursor-pointer overflow-hidden rounded-2xl bg-primary px-6 py-5 text-base font-semibold text-primary-foreground shadow-[inset_0_1px_0_0_rgba(255,255,255,0.12),0_10px_22px_-12px_rgba(61,46,34,0.5)] outline-none transition-[transform,box-shadow] duration-200 ease-out enabled:hover:-translate-y-0.5 enabled:hover:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.16),0_18px_32px_-12px_rgba(61,46,34,0.58)] enabled:active:translate-y-0 enabled:active:scale-[0.98] focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none"
    >
      {/* A soft top-down sheen lifts the flat fill into a tactile surface. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/10 to-transparent"
      />
      {submitting || advancing ? (
        <span className="relative flex items-center justify-center gap-2">
          <CircleNotch className="size-5 animate-spin motion-reduce:animate-none" />
          {advancing
            ? msg("submit.nav.validating")
            : msg("auto.features.submit.components.submitnav.3")}
        </span>
      ) : (
        <div className="relative flex flex-col items-center gap-2">
          <span className="flex flex-col items-center gap-1">
            <span>
              {msg("auto.features.submit.components.submitnav.4")}
              {TERMS.optimization}
            </span>
            {runDisabledReason && (
              <span className="text-xs font-normal text-primary-foreground/90" dir="auto">
                {runDisabledReason}
              </span>
            )}
          </span>
          <div
            aria-hidden="true"
            className="flex flex-col items-center -space-y-2 text-primary-foreground/60 transition-colors duration-200 group-hover:text-primary-foreground [&>svg]:animate-[cascadeDown_1.4s_ease-in-out_infinite] group-hover:[&>svg]:animate-[cascadeDownHyper_0.6s_ease-out_infinite] motion-reduce:[&>svg]:animate-none motion-reduce:group-hover:[&>svg]:animate-none"
          >
            <CaretDown className="size-4 [animation-delay:0s]" />
            <CaretDown className="size-4 [animation-delay:0.18s] group-hover:[animation-delay:0.1s]" />
            <CaretDown className="size-4 [animation-delay:0.36s] group-hover:[animation-delay:0.2s]" />
          </div>
        </div>
      )}
    </button>
  );
}
