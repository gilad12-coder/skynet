"use client";

import { CaretLeft, CaretRight, CircleNotch, RocketLaunch, Warning } from "@/shared/ui/icons";
import { motion, useReducedMotion } from "framer-motion";
import { Button } from "@/shared/ui/primitives/button";
import { TERMS } from "@/shared/lib/terms";
import { msg } from "@/shared/lib/messages";
import { getActiveDir } from "@/shared/lib/runtime-locale";

import { LAST_WIZARD_STAGE, WIZARD_STAGE } from "../lib/wizard-steps";
import type { WizardV2Shell } from "../hooks/use-unified-wizard";

type NavContext = Pick<
  WizardV2Shell,
  "state" | "goPrev" | "goNext" | "submit" | "submitting" | "advancing"
> & {
  // Why the run cannot start right now (a failing or stale contract check);
  // the button stays visible and shows the reason as its tooltip.
  runDisabledReason?: string | null;
};

/** Why the last Run click did not start a run, kept on screen until the setup changes. */
export interface RunFailureNotice {
  text: string;
  /** The server's own account of the failure. */
  detail: string | null;
  action?: { label: string; onClick: () => void };
}

interface SubmitNavProps {
  w: NavContext;
  onBack?: () => void;
  onNext?: () => void;
  onSubmit?: () => void;
  backDisabled?: boolean;
  /** Keeps Continue closed, e.g. while the step's answers are invalid. */
  nextDisabled?: boolean;
  showSubmit?: boolean;
  /** Where the user is among the current step's screens; shown as dots. */
  screen?: { index: number; count: number };
  runFailure?: RunFailureNotice | null;
}

function RunFailureBox({ failure }: { failure: RunFailureNotice }) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-4"
    >
      <div className="min-w-0 space-y-1">
        <p className="flex items-start gap-2 font-medium text-destructive">
          <Warning className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{failure.text}</span>
        </p>
        {failure.detail && (
          <p className="break-words ps-6 text-xs text-muted-foreground" dir="auto">
            {failure.detail}
          </p>
        )}
      </div>
      {failure.action && (
        <Button
          variant="outline"
          size="sm"
          onClick={failure.action.onClick}
          className="shrink-0 self-start sm:self-center"
        >
          {failure.action.label}
        </Button>
      )}
    </div>
  );
}

function ScreenDots({ index, count }: { index: number; count: number }) {
  if (count < 2) return null;
  return (
    <div
      className="flex items-center gap-1.5 self-center"
      role="img"
      aria-label={msg("submit.nav.screen", { index: index + 1, count })}
    >
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          className={`h-1.5 rounded-full transition-all duration-300 ${
            i === index ? "w-4 bg-primary-fill" : "w-1.5 bg-muted-foreground/30"
          }`}
        />
      ))}
    </div>
  );
}

export function SubmitNav({
  w,
  onBack,
  onNext,
  onSubmit,
  backDisabled,
  nextDisabled,
  showSubmit,
  screen,
  runFailure,
}: SubmitNavProps) {
  const reducedMotion = useReducedMotion();
  const { goPrev, goNext, submit, submitting, advancing } = w;
  const step = WIZARD_STAGE[w.state.step];
  const runDisabledReason = w.runDisabledReason ?? null;

  // Back points toward the start, Next toward the end — the physical direction
  // of each flips with the locale (left/right swap in RTL).
  const rtl = getActiveDir() === "rtl";
  const BackChevron = rtl ? CaretRight : CaretLeft;
  const NextChevron = rtl ? CaretLeft : CaretRight;

  const renderSubmit = showSubmit ?? step >= LAST_WIZARD_STAGE;

  const backButton = (
    <Button
      variant="outline"
      onClick={onBack ?? goPrev}
      disabled={(backDisabled ?? step === 0) || advancing || submitting}
      className="min-h-[44px] lg:min-h-0 min-w-0 flex-1 gap-2 whitespace-normal sm:flex-none sm:whitespace-nowrap"
    >
      <BackChevron className="h-4 w-4" />
      {msg("auto.features.submit.components.submitnav.1")}
    </Button>
  );

  if (!renderSubmit) {
    return (
      <div className="flex items-stretch justify-between gap-3">
        {backButton}
        {screen && <ScreenDots index={screen.index} count={screen.count} />}
        <div className="flex min-w-0 flex-1 items-center justify-end gap-3 sm:flex-none">
          <Button
            onClick={onNext ?? goNext}
            disabled={advancing || nextDisabled}
            aria-busy={advancing || undefined}
            aria-live="polite"
            className="min-h-[44px] lg:min-h-0 min-w-0 flex-1 justify-center gap-2 whitespace-normal sm:min-w-[88px] sm:flex-none sm:whitespace-nowrap"
            data-tutorial="wizard-next"
          >
            {advancing ? (
              <>
                <CircleNotch
                  className="animate-spin motion-reduce:animate-none"
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
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {runFailure && !submitting && !advancing && <RunFailureBox failure={runFailure} />}
      <div className="flex items-stretch gap-3">
        {backButton}
        <motion.button
          type="button"
          onClick={onSubmit ?? (() => void submit())}
          disabled={submitting || advancing || runDisabledReason !== null}
          aria-busy={submitting || advancing || undefined}
          aria-disabled={runDisabledReason !== null || undefined}
          title={runDisabledReason ?? undefined}
          data-tutorial="submit-button"
          data-telemetry="submit-run"
          animate={runDisabledReason || reducedMotion ? { scale: 1 } : { scale: [1, 1.01, 1] }}
          transition={{ repeat: Infinity, duration: 3, ease: "easeInOut" }}
          className="min-h-[44px] lg:min-h-0 lg:h-9 min-w-0 flex-1 inline-flex items-center justify-center gap-2 rounded-md bg-primary-fill px-4 text-sm font-semibold text-primary-foreground cursor-pointer transition-colors duration-200 hover:bg-primary-hover active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {submitting || advancing ? (
            <>
              <CircleNotch className="size-4 animate-spin motion-reduce:animate-none" />
              {advancing
                ? msg("submit.nav.validating")
                : msg("auto.features.submit.components.submitnav.3")}
            </>
          ) : (
            <>
              <RocketLaunch className="size-4" aria-hidden />
              {msg("auto.features.submit.components.submitnav.4")}
              {TERMS.optimization}
            </>
          )}
        </motion.button>
      </div>
    </div>
  );
}
