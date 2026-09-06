"use client";

import { useCallback, useRef, useState } from "react";
import type { WizardPreflightResponse } from "@/shared/types/wizard-preflight";
import type { ToastApi } from "../lib/validation-toast";

export type ValidationPhase =
  | "budget"
  | "dependencies"
  | "sandbox"
  | "evaluator"
  | "models"
  | "usage";
export interface ValidationProgress {
  open: boolean;
  status: "running" | "succeeded" | "failed" | "pending";
  startedAt: number;
  finishedAt?: number;
  phases: Array<{ key: ValidationPhase; startedAt: number; finishedAt?: number }>;
  response?: WizardPreflightResponse;
  message?: string;
}

export function useValidationProgress() {
  const [state, setState] = useState<ValidationProgress | null>(null);
  const active = useRef(false);
  const start = useCallback(() => {
    if (active.current) return;
    active.current = true;
    const now = Date.now();
    setState({
      open: true,
      status: "running",
      startedAt: now,
      phases: [{ key: "budget", startedAt: now }],
    });
  }, []);
  const phase = useCallback((key: ValidationPhase) => {
    setState((previous) => {
      if (
        !previous ||
        previous.status !== "running" ||
        previous.phases.at(-1)?.key === key ||
        (key === "budget" && previous.phases.some((item) => item.key === key))
      )
        return previous;
      const now = Date.now();
      return {
        ...previous,
        phases: [
          ...previous.phases.map((item) => ({ ...item, finishedAt: item.finishedAt ?? now })),
          { key, startedAt: now },
        ],
      };
    });
  }, []);
  const finish = useCallback(
    (
      status: ValidationProgress["status"],
      message?: string,
      response?: WizardPreflightResponse,
    ) => {
      active.current = false;
      setState((previous) =>
        previous
          ? {
              ...previous,
              status,
              message,
              response: response ?? previous.response,
              finishedAt: Date.now(),
            }
          : previous,
      );
    },
    [],
  );
  const result = useCallback((response: WizardPreflightResponse) => {
    setState((previous) => (previous ? { ...previous, response } : previous));
  }, []);
  const feedback: ToastApi = {
    loading: () => {
      start();
      return "validation-modal";
    },
    update: (_id, update) => {
      if (!update.isLoading)
        finish(
          update.type === "error" ? "failed" : update.type === "success" ? "succeeded" : "pending",
          update.render,
        );
    },
    dismiss: () => {
      active.current = false;
      setState(null);
    },
  };
  return {
    state,
    start,
    phase,
    finish,
    result,
    feedback,
    setOpen: (open: boolean) =>
      setState((previous) => (previous ? { ...previous, open } : previous)),
  };
}
