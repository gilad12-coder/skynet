"use client";

import {
  createContext,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createExecutionBudget, getExecutionBudget, updateExecutionBudget } from "@/shared/lib/api";
import { msg } from "@/shared/lib/messages";
import type { MessageKey } from "@/shared/lib/generated/ui-catalog";
import { ExecutionBudgetSession } from "../lib/execution-budget-session";
import { useWizardDrafts } from "./use-wizard-drafts";

const BudgetContext = createContext<{ session: ExecutionBudgetSession; revision: number } | null>(
  null,
);

/** One server budget follows the user across both wizard workflows. */
export function ExecutionBudgetProvider({ children }: { children: ReactNode }) {
  const drafts = useWizardDrafts();
  const [revision, changed] = useReducer((revision: number) => revision + 1, 0);
  const [session] = useState(
    () =>
      new ExecutionBudgetSession(drafts.takeExecution(), {
        persist: drafts.saveExecution,
        create: createExecutionBudget,
        get: getExecutionBudget,
        update: updateExecutionBudget,
        changed,
      }),
  );
  const effectGeneration = useRef(0);
  useEffect(() => {
    const generation = ++effectGeneration.current;
    void session.refresh().catch(() => {});
    return () => {
      // React's development effect replay keeps this instance; a real unmount fences it.
      queueMicrotask(() => {
        if (effectGeneration.current === generation) session.detach();
      });
    };
  }, [session]);
  return <BudgetContext.Provider value={{ session, revision }}>{children}</BudgetContext.Provider>;
}

export function useExecutionBudget() {
  const context = useContext(BudgetContext);
  if (!context) throw new Error("ExecutionBudgetProvider is required");
  const { session } = context;
  const error = session.error?.startsWith("budget.")
    ? msg(session.error as MessageKey)
    : session.error;
  return {
    session,
    maxCostCredits: session.draft.budgetTotalCredits ?? null,
    setMaxCostCredits: (total: number | null) => session.setTotal(total),
    budgetUncapped: session.draft.budgetUncapped ?? false,
    setBudgetUncapped: (uncapped: boolean) => session.setUncapped(uncapped),
    budget: session.budget,
    budgetBusy: session.busy,
    budgetError: error ?? (session.persistenceUnavailable ? msg("submit.draft.save_failed") : null),
    minimumTotalCredits: session.minimumTotalCredits,
    setupSpent: session.budget ? Number(session.budget.setup_spent_credits) : 0,
    availableCredits: session.budget ? Number(session.budget.available_credits) : null,
  };
}
