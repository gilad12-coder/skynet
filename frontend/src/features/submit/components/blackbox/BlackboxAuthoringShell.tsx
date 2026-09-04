"use client";

import type { ReactNode } from "react";
import { msg } from "@/shared/lib/messages";

import type { BlackboxWizardContext } from "../../hooks/use-blackbox-wizard";
import { AuthoringShell } from "../steps/AuthoringShell";
import { CodeAgentPanel } from "../steps/CodeAgentPanel";
import { CodeInterviewPanel } from "../steps/CodeInterviewPanel";

// The Starting point and Scorer steps share one authoring surface: the
// agent (or its opening interview) on the start side, the step's own
// fields on the end side. The agent needs an objective to work from, so an
// empty one disables it with a reason.
export function BlackboxAuthoringShell({
  w,
  start,
  title,
  description,
  children,
}: {
  w: BlackboxWizardContext;
  start?: ReactNode;
  title: ReactNode;
  description?: string;
  children: ReactNode;
}) {
  const { codeAssistMode, setCodeAssistMode, objective, agent, interview, interviewEligible } = w;
  const disabledReason = objective.trim()
    ? undefined
    : msg("submit.blackbox.agent.objective_required");
  // The interview owns the agent-panel slot until it resolves — but never
  // over an existing conversation.
  const interviewActive =
    interviewEligible &&
    !interview.resolved &&
    agent.messages.length === 0 &&
    agent.signatureVersions.length === 0 &&
    agent.metricVersions.length === 0;

  return (
    <AuthoringShell
      value={codeAssistMode}
      onChange={setCodeAssistMode}
      disabledReason={disabledReason}
      start={start}
      title={title}
      description={description}
      sidePanel={
        interviewActive ? (
          <CodeInterviewPanel interview={interview} blackbox className="absolute inset-0" />
        ) : (
          <CodeAgentPanel
            agent={agent}
            model={interview.model}
            onModelChange={interview.setModel}
            reasoningEffort={interview.reasoningEffort}
            onReasoningEffortChange={interview.setReasoningEffort}
            disabled={!!disabledReason}
            disabledReason={disabledReason}
            blackbox
            className="absolute inset-0"
          />
        )
      }
    >
      {/* The body grows with the card, so a field that asks to fill it (the
          brief, the seed) takes the room instead of leaving it empty. It is
          also the box an expanded textarea covers. */}
      <div className="relative flex min-h-0 flex-1 flex-col gap-5 px-4 py-5 sm:px-6 sm:py-6">
        {children}
      </div>
    </AuthoringShell>
  );
}
