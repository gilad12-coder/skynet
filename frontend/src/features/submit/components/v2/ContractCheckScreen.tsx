"use client";

import { useEffect, useRef } from "react";
import { contractCheckMessage } from "@/shared/lib/i18n";
import type { ContractCheckState } from "../../hooks/use-contract-check";
import { CONTRACT_CHECK_PLAN, contractValidation } from "../../lib/contract-validation";
import { ValidationFrame, ValidationPlan } from "../ValidationFrame";
import { v2Msg } from "./ArtifactConfirmCard";

/**
 * The sandbox check, a screen of its own between the code and the overview:
 * it runs the run code and the metric on a few samples when the screen opens,
 * on the setup-check layout, and its fresh pass is what unblocks Run.
 */
export function ContractCheckScreen({
  cc,
  guided,
  active,
  onBack,
}: {
  cc: ContractCheckState;
  guided: boolean;
  active: boolean;
  onBack: () => void;
}) {
  const fresh = cc.lastCheck !== null && !cc.stale;
  const { canCheck } = cc;
  const latest = useRef({ cc, fresh });
  useEffect(() => {
    latest.current = { cc, fresh };
  });
  // Opening the screen runs the check, as Continue into the old check page did.
  // A fresh result is shown as it stands, and a failed one waits for the next visit.
  useEffect(() => {
    if (!active) return;
    const { cc: current, fresh: done } = latest.current;
    if (current.canCheck && !current.checking && !done) void current.check();
  }, [active]);

  const progress = contractValidation({
    result: fresh ? cc.lastCheck : null,
    checking: cc.checking,
    error: cc.error,
    timing: cc.timing,
    message: contractCheckMessage,
  });

  return (
    <div className="mx-auto w-full max-w-3xl">
      {progress ? (
        <ValidationFrame state={progress} onBack={onBack} plan={CONTRACT_CHECK_PLAN} settled />
      ) : (
        <ValidationPlan
          workflow="unified"
          scope="execution"
          plan={CONTRACT_CHECK_PLAN}
          stale={cc.lastCheck !== null && cc.stale}
          description={canCheck ? undefined : v2Msg("submit.v2.metric.check.incomplete", guided)}
        />
      )}
    </div>
  );
}
