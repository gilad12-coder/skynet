"use client";

import * as React from "react";
import { msg, type MessageKey } from "@/shared/lib/messages";
import { runContractCheck, staticContractCheck } from "@/shared/lib/api";
import { track, TelemetryEvent } from "@/shared/lib/telemetry";
import type { ContractCheckResponse } from "@/shared/types/unified-run";
import type { ContractCheckTiming } from "../lib/contract-validation";
import { contractSnapshot, withContractBudget, type WizardV2Context } from "../lib/wizard-v2";
import { contractFailure } from "../lib/wizard-telemetry";

// Typing pauses this long before the static (no-sandbox) check runs.
const STATIC_DEBOUNCE_MS = 700;
const SANDBOX_SAMPLE_COUNT = 3;

export interface ContractCheckState {
  /** Signature/shape result for the code as typed; never gates Run. */
  staticResult: ContractCheckResponse | null;
  staticPending: boolean;
  /** The last sandboxed check; Run needs it passing and fresh. */
  lastCheck: ContractCheckResponse | null;
  stale: boolean;
  checking: boolean;
  /** Transport or auth failure of the sandboxed check, not a contract failure. */
  error: string | null;
  /** When the latest sandboxed check started and reached each step, for the check screen. */
  timing: ContractCheckTiming | null;
  /** False while the setup cannot build a payload yet. */
  canCheck: boolean;
  /** Runs the sandboxed check; resolves to its result, or null when it did not finish. */
  check: () => Promise<ContractCheckResponse | null>;
}

function errorText(error: unknown): string {
  if (!(error instanceof Error) || !error.message) return msg("submit.preflight.failed");
  // The budget session throws i18n keys (`budget.invalid`, `budget.conflict`, ...).
  return error.message.startsWith("budget.") ? msg(error.message as MessageKey) : error.message;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function useContractCheck(ctx: WizardV2Context): ContractCheckState {
  const { state, buildPayload, ensureBudget, patchWorkspace, contractStale } = ctx;
  const snapshot = contractSnapshot(state);
  const buildRef = React.useRef(buildPayload);
  // Declared before the effects that read it, so they see this render's builder.
  React.useEffect(() => {
    buildRef.current = buildPayload;
  });

  const [staticResult, setStaticResult] = React.useState<ContractCheckResponse | null>(null);
  const [staticPending, setStaticPending] = React.useState(false);
  const [checking, setChecking] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [timing, setTiming] = React.useState<ContractCheckTiming | null>(null);
  const checkAbortRef = React.useRef<AbortController | null>(null);

  const canCheck = buildPayload() !== null;

  React.useEffect(() => {
    const spec = buildRef.current();
    if (!spec) {
      setStaticResult(null);
      setStaticPending(false);
      return;
    }
    const controller = new AbortController();
    setStaticPending(true);
    const timer = window.setTimeout(() => {
      staticContractCheck({ spec, sample_count: 1 }, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted) setStaticResult(result);
        })
        .catch(() => {
          // The sandboxed check reports the same problems with full detail;
          // a failed static pass only leaves the previous hint on screen.
        })
        .finally(() => {
          if (!controller.signal.aborted) setStaticPending(false);
        });
    }, STATIC_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [snapshot]);

  React.useEffect(() => () => checkAbortRef.current?.abort(), []);

  const check = React.useCallback(async () => {
    const spec = buildRef.current();
    if (!spec) return null;
    checkAbortRef.current?.abort();
    const controller = new AbortController();
    checkAbortRef.current = controller;
    // The snapshot is taken before the request: an edit made while the check
    // runs leaves its result stale instead of passing code it never saw.
    const checkedSnapshot = snapshot;
    setChecking(true);
    setError(null);
    setTiming({ startedAt: Date.now() });
    try {
      const budget = await ensureBudget();
      if (controller.signal.aborted) return null;
      setTiming((current) => current && { ...current, requestAt: Date.now() });
      const result = await runContractCheck(
        { spec: withContractBudget(spec, budget), sample_count: SANDBOX_SAMPLE_COUNT },
        controller.signal,
        (phase) => {
          // The server's own steps; anything else (or a repeat) moves nothing.
          const stamp = phase === "sandbox" ? "sandboxAt" : phase === "evaluator" ? "evaluatorAt" : null;
          if (!stamp) return;
          setTiming((current) =>
            current && !current[stamp] ? { ...current, [stamp]: Date.now() } : current,
          );
        },
      );
      if (controller.signal.aborted) return null;
      patchWorkspace({ lastCheck: result, lastCheckSnapshot: checkedSnapshot });
      const failure = contractFailure(result);
      if (failure) track(TelemetryEvent.SetupCheckFailed, { ...failure });
      return result;
    } catch (err) {
      if (!isAbort(err) && !controller.signal.aborted) {
        setError(errorText(err));
        track(TelemetryEvent.SetupCheckFailed, { ...contractFailure(null) });
      }
      return null;
    } finally {
      if (checkAbortRef.current === controller) {
        checkAbortRef.current = null;
        setChecking(false);
        setTiming((current) => current && { ...current, finishedAt: Date.now() });
      }
    }
  }, [snapshot, ensureBudget, patchWorkspace]);

  return {
    staticResult,
    staticPending,
    lastCheck: state.workspace.lastCheck,
    stale: contractStale,
    checking,
    error,
    timing,
    canCheck,
    check,
  };
}
