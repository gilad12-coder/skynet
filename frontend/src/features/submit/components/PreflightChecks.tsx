"use client";

import { CheckCircle, CircleNotch, Warning } from "@/shared/ui/icons";
import { msg } from "@/shared/lib/messages";
import { TERMS } from "@/shared/lib/terms";
import type { PreflightScope } from "@/shared/types/wizard-preflight";
import type { WizardPreflightContext } from "../hooks/use-wizard-preflight";
import { preflightPendingMessageKey } from "../lib/preflight-outcome";

function checkLabel(key: string): string | null {
  if (/model\.(optimization|reflection)/.test(key))
    return msg("submit.blackbox.roles.optimization.label");
  if (/model\.(task|generation)|sample_prediction/.test(key))
    return msg("submit.blackbox.roles.task.label");
  if (/model\.(scor|evaluation)/.test(key)) return msg("submit.blackbox.roles.scoring.label");
  if (/scorer|metric/.test(key)) return msg("submit.blackbox.scorer.title");
  if (/program/.test(key)) return TERMS.module;
  if (/mapping|dataset/.test(key)) return TERMS.dataset;
  if (/optimizer/.test(key)) return TERMS.optimizer;
  if (/runtime/.test(key)) return msg("submit.blackbox.runtime.label");
  return null;
}

/** Render only the scope and checks actually attested by the server. */
export function PreflightChecks({
  preflight,
  scope,
}: {
  preflight: WizardPreflightContext;
  scope: PreflightScope;
}) {
  const execution = preflight.evidence.execution;
  const displayedScope =
    scope === "evaluation" &&
    execution?.identity === preflight.identity &&
    execution.response.status === "failed"
      ? "execution"
      : scope;
  const evidence = preflight.evidence[displayedScope];
  const current = evidence?.identity === preflight.identity;
  const running = preflight.running[scope] === preflight.identity;
  const status = current ? evidence?.response.status : evidence ? "stale" : "idle";
  return (
    <section
      id={scope === "execution" ? "execution-preflight-checks" : undefined}
      tabIndex={scope === "execution" ? -1 : undefined}
      className="space-y-2 rounded-lg border border-border/50 bg-muted/20 p-3"
      aria-live="polite"
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        {running ? (
          <CircleNotch
            className="size-4 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
        ) : status === "succeeded" ? (
          <CheckCircle className="size-4 text-green-700" aria-hidden="true" />
        ) : (
          <Warning className="size-4 text-muted-foreground" aria-hidden="true" />
        )}
        {msg(
          displayedScope === "evaluation"
            ? "submit.preflight.evaluation"
            : "submit.preflight.execution",
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {running
          ? msg("submit.validation.toast.running")
          : current && evidence?.response.status === "pending"
            ? msg(preflightPendingMessageKey(evidence.response))
            : msg(`submit.preflight.${status ?? "idle"}`)}
      </p>
      {current && evidence && (
        <ul className="space-y-1 text-xs text-muted-foreground">
          {evidence.response.checks.map((check, index) => (
            <li
              key={`${check.key}:${index}`}
              className={check.status === "failed" ? "text-destructive" : undefined}
            >
              {checkLabel(check.key) && (
                <span className="font-medium">{checkLabel(check.key)}: </span>
              )}
              {check.message || msg(`submit.preflight.${check.status}`)}
            </li>
          ))}
        </ul>
      )}
      {preflight.error && (
        <p className="break-words text-xs text-destructive" role="alert">
          {preflight.error}
        </p>
      )}
    </section>
  );
}
