"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { msg } from "@/shared/lib/messages";
import type { MessageKey } from "@/shared/lib/generated/ui-catalog";
import { runWizardPreflight } from "@/shared/lib/api";
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
import { preflightIdentity } from "../lib/validation-evidence";
import { waitForPreflightUsage } from "../lib/wait-for-preflight-usage";

import { useValidationProgress, type ValidationPhase } from "./use-validation-progress";

export type PreflightEvidence = StoredPreflightEvidence;

/** Keep checks scoped to the current setup; server evidence and costs remain authoritative. */
export function useWizardPreflight(
  workflow: "anything" | "dspy",
  payload: WizardPreflightPayload,
  budget: ExecutionBudgetSession,
) {
  const progress = useValidationProgress();
  const { start, phase, finish, result } = progress;
  const identity = preflightIdentity(workflow, payload);
  const [evidence, setEvidence] = useState<Partial<Record<PreflightScope, PreflightEvidence>>>({});
  const [running, setRunning] = useState<Partial<Record<PreflightScope, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const evidenceRef = useRef<Partial<Record<PreflightScope, PreflightEvidence>>>({});
  const identityRef = useRef(identity);
  const mounted = useRef(true);
  const requests = useRef(new Map<string, Promise<WizardPreflightResponse>>());
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    identityRef.current = identity;
  }, [identity]);
  useEffect(() => {
    mounted.current = true;
    controller.current = new AbortController();
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);

  const rememberEvidence = useCallback(
    (
      update: (
        previous: Partial<Record<PreflightScope, PreflightEvidence>>,
      ) => Partial<Record<PreflightScope, PreflightEvidence>>,
    ) => {
      const next = update(evidenceRef.current);
      evidenceRef.current = next;
      setEvidence(next);
    },
    [],
  );

  const reusable = useCallback(
    (scope: PreflightScope, overridePayload: WizardPreflightPayload = payload) =>
      reusableSuccessfulPreflight(
        evidenceRef.current,
        scope,
        preflightIdentity(workflow, overridePayload),
      ),
    [payload, workflow],
  );

  const run = useCallback(
    async (
      scope: PreflightScope,
      overridePayload: WizardPreflightPayload = payload,
    ): Promise<WizardPreflightResponse> => {
      const requestIdentity = preflightIdentity(workflow, overridePayload);
      const completed = reusableSuccessfulPreflight(evidenceRef.current, scope, requestIdentity);
      if (completed) return completed;
      const key = `${scope}:${requestIdentity}`;
      const pending = requests.current.get(key);
      if (pending) return pending;
      start();
      const signal = controller.current?.signal;
      setRunning((previous) => ({ ...previous, [scope]: requestIdentity }));
      setError(null);
      if (requestIdentity === identityRef.current)
        rememberEvidence((previous) => ({ ...previous, [scope]: undefined }));
      const work = (async () => {
        const currentBudget = await budget.ensure();
        if (signal?.aborted) throw new DOMException("Preflight cancelled", "AbortError");
        let response = await runWizardPreflight(
          {
            scope,
            workflow,
            payload: overridePayload,
            execution_budget_id: currentBudget.id,
            execution_budget_revision: currentBudget.revision,
          },
          signal,
          (value) => {
            if (
              !signal?.aborted &&
              ["budget", "sandbox", "evaluator", "models", "usage"].includes(value)
            )
              phase(value as ValidationPhase);
          },
        );
        signal?.throwIfAborted();
        await budget.adopt(response.budget);
        result(response);
        if (response.pending_reason?.category === "usage_reconciliation") phase("usage");
        response = await waitForPreflightUsage(
          response,
          () => {
            if (requestIdentity !== identityRef.current)
              throw new DOMException("Preflight inputs changed", "AbortError");
            return budget.refresh();
          },
          (settledBudget) => {
            if (requestIdentity !== identityRef.current)
              throw new DOMException("Preflight inputs changed", "AbortError");
            return runWizardPreflight(
              {
                scope,
                workflow,
                payload: overridePayload,
                execution_budget_id: settledBudget.id,
                execution_budget_revision: settledBudget.revision,
              },
              signal,
              (value) => {
                if (
                  !signal?.aborted &&
                  ["budget", "sandbox", "evaluator", "models", "usage"].includes(value)
                )
                  phase(value as ValidationPhase);
              },
            );
          },
          signal,
        );
        await budget.adopt(response.budget);
        if (mounted.current && !signal?.aborted && requestIdentity === identityRef.current) {
          rememberEvidence((previous) => ({
            ...previous,
            [scope]: { identity: requestIdentity, response },
          }));
          finish(response.status, undefined, response);
        }
        return response;
      })()
        .catch((failure: unknown) => {
          if (
            mounted.current &&
            requestIdentity === identityRef.current &&
            !(failure instanceof DOMException && failure.name === "AbortError")
          ) {
            const message = failure instanceof Error ? failure.message : String(failure);
            const translated = message.startsWith("budget.") ? msg(message as MessageKey) : message;
            setError(translated);
            finish("failed", translated);
          }
          throw failure;
        })
        .finally(() => {
          requests.current.delete(key);
          if (mounted.current)
            setRunning((previous) =>
              previous[scope] === requestIdentity ? { ...previous, [scope]: undefined } : previous,
            );
        });
      requests.current.set(key, work);
      return work;
    },
    [workflow, payload, budget, rememberEvidence, start, phase, finish, result],
  );

  const cancel = () => {
    controller.current?.abort();
    controller.current = new AbortController();
  };
  const isCurrent = (candidate: string) => candidate === identityRef.current;
  return {
    identity,
    evidence,
    running,
    error,
    reusable,
    run,
    cancel,
    isCurrent,
    progress,
    feedback: progress.feedback,
  };
}
export type WizardPreflightContext = ReturnType<typeof useWizardPreflight>;
