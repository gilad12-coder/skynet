"use client";

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { msg } from "@/shared/lib/messages";
import type { MessageKey } from "@/shared/lib/generated/ui-catalog";
import { getExecutionBudget, runWizardPreflight } from "@/shared/lib/api";
import type {
  PreflightScope,
  WizardPreflightPayload,
  WizardPreflightResponse,
} from "@/shared/types/wizard-preflight";
import type { ExecutionBudgetSession } from "../lib/execution-budget-session";
import {
  reusableSuccessfulPreflight,
  type StoredPreflightEvidence,
} from "../lib/preflight-outcome";
import {
  PreflightStore,
  type PreflightWorkflow,
  type ValidationPhase,
  type ValidationProgress,
  type ValidationStatus,
} from "../lib/preflight-store";
import { preflightIdentity } from "../lib/validation-evidence";
import type { ToastApi } from "../lib/validation-toast";
import { waitForPreflightUsage } from "../lib/wait-for-preflight-usage";

export type PreflightEvidence = StoredPreflightEvidence;
export type { ValidationPhase, ValidationProgress };

// One store for the page: a check keeps running while the user is elsewhere
// in the app, and a wizard restored from the draft joins it where it is.
const store = new PreflightStore({
  preflight: runWizardPreflight,
  getBudget: getExecutionBudget,
  translate: (key) => msg(key as MessageKey),
  identity: preflightIdentity,
  reusable: reusableSuccessfulPreflight,
  settleUsage: waitForPreflightUsage,
});

/** Keep checks scoped to the current setup; server evidence and costs remain authoritative. */
export function useWizardPreflight(
  workflow: PreflightWorkflow,
  payload: WizardPreflightPayload,
  budget: ExecutionBudgetSession,
) {
  const identity = preflightIdentity(workflow, payload);
  const getSnapshot = useCallback(() => store.getState(workflow), [workflow]);
  const state = useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);

  const identityRef = useRef(identity);
  useEffect(() => {
    identityRef.current = identity;
  }, [identity]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    store.attach(workflow, budget);
    return () => {
      mounted.current = false;
      store.detach(workflow, budget);
    };
  }, [workflow, budget]);

  const reusable = useCallback(
    (scope: PreflightScope, overridePayload: WizardPreflightPayload = payload) =>
      store.reusable(
        workflow,
        scope,
        preflightIdentity(workflow, overridePayload),
        budget.draft.executionBudgetRef?.id,
      ),
    [workflow, payload, budget],
  );
  const run = useCallback(
    (scope: PreflightScope, overridePayload: WizardPreflightPayload = payload) =>
      store.run(workflow, scope, overridePayload, budget),
    [workflow, payload, budget],
  );
  const cancel = useCallback(() => store.cancel(workflow), [workflow]);
  const isCurrent = useCallback((candidate: string) => candidate === identityRef.current, []);

  const progress = useMemo(
    () => ({
      start: (scope: PreflightScope) =>
        store.start(workflow, { scope, identity: identityRef.current, owner: budget }),
      phase: (key: ValidationPhase) => store.phase(workflow, key),
      finish: (
        status: Exclude<ValidationStatus, "running">,
        message?: string,
        response?: WizardPreflightResponse,
      ) => store.finish(workflow, status, message, response),
      result: (response: WizardPreflightResponse) => store.result(workflow, response),
      clear: () => store.clear(workflow),
    }),
    [workflow, budget],
  );

  // This wizard shows a check it started itself, whatever it was checking, and
  // one another instance started for the same setup (a draft continued after
  // leaving the page). A different setup's check stays out of sight.
  const shown =
    state.progress && (state.progress.owner === budget || state.progress.identity === identity)
      ? state.progress
      : null;

  const feedback = useCallback(
    (scope: PreflightScope): ToastApi => ({
      loading: () => {
        if (mounted.current) progress.start(scope);
        return "validation-frame";
      },
      update: (_id, update) => {
        if (!mounted.current || update.isLoading) return;
        progress.finish(
          update.type === "error" ? "failed" : update.type === "success" ? "succeeded" : "pending",
          update.render,
        );
      },
      dismiss: () => {
        // A running check is never dismissed: it ends on its own, on screen.
        if (mounted.current && store.getState(workflow).progress?.status !== "running")
          progress.clear();
      },
    }),
    [workflow, progress],
  );

  return {
    identity,
    evidence: state.evidence,
    running: state.running,
    error: state.error,
    reusable,
    run,
    cancel,
    isCurrent,
    progress: { ...progress, state: shown },
    feedback,
  };
}

export type WizardPreflightContext = ReturnType<typeof useWizardPreflight>;
