"use client";

import { useEffect, useRef, useState } from "react";
import { contractCheckMessage } from "@/shared/lib/i18n";
import { formatMsg, msg } from "@/shared/lib/messages";
import type { CheckTerminalPhase } from "@/shared/types/unified-run";
import {
  CheckTerminalSheet,
  sampleProgress,
  type CheckTerminalPhaseState,
} from "@/features/trajectory/check-terminal";
import type { ContractCheckState } from "../../hooks/use-contract-check";
import { CONTRACT_CHECK_PLAN, contractValidation } from "../../lib/contract-validation";
import { ValidationFrame, ValidationPlan } from "../ValidationFrame";
import { v2Msg } from "./ArtifactConfirmCard";

const PHASE_LABELS = {
  budget: "submit.validation.progress.budget",
  sandbox: "submit.validation.progress.sandbox",
  evaluator: "submit.validation.progress.evaluator",
} as const;

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

  const [logPhase, setLogPhase] = useState<CheckTerminalPhase | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!cc.checking || logPhase === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [cc.checking, logPhase]);
  const log = cc.terminal;
  const samples = log ? sampleProgress(log.events) : null;
  const terminalPhases: CheckTerminalPhaseState[] = CONTRACT_CHECK_PLAN.map((key) => {
    const rows = progress?.phases ?? [];
    const index = rows.findIndex((row) => row.key === key);
    const row = rows[index];
    const last = index === rows.length - 1;
    const status: CheckTerminalPhaseState["status"] = !row
      ? "waiting"
      : last && progress?.status === "running"
        ? "running"
        : last && progress?.status === "failed"
          ? "failed"
          : "done";
    const end = row?.finishedAt ?? (status === "running" ? now : progress?.finishedAt);
    return {
      key: key as CheckTerminalPhase,
      label: msg(PHASE_LABELS[key as CheckTerminalPhase]),
      status,
      elapsedMs:
        row && row.startedAt > 0 && end !== undefined
          ? Math.max(0, end - row.startedAt)
          : undefined,
    };
  });

  return (
    <div className="mx-auto w-full max-w-3xl">
      {progress ? (
        <ValidationFrame
          state={progress}
          onBack={onBack}
          plan={CONTRACT_CHECK_PLAN}
          settled
          onOpenPhase={log ? (phase) => setLogPhase(phase as CheckTerminalPhase) : undefined}
          phaseNote={(phase) =>
            phase === "evaluator" && samples && cc.checking
              ? formatMsg("check_terminal.samples_done", samples)
              : undefined
          }
        />
      ) : (
        <ValidationPlan
          workflow="unified"
          scope="execution"
          plan={CONTRACT_CHECK_PLAN}
          stale={cc.lastCheck !== null && cc.stale}
          description={canCheck ? undefined : v2Msg("submit.v2.metric.check.incomplete", guided)}
        />
      )}
      <CheckTerminalSheet
        log={log}
        phases={terminalPhases}
        phase={logPhase}
        onPhaseChange={setLogPhase}
        live={cc.checking}
      />
    </div>
  );
}
