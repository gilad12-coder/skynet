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
  title,
  description,
  children,
}: {
  w: BlackboxWizardContext;
  title: ReactNode;
  description?: ReactNode;
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
      title={title}
      description={description}
      sidePanel={
        interviewActive ? (
          <CodeInterviewPanel
            interview={interview}
            subtitle={msg("submit.blackbox.interview.subtitle")}
            className="absolute inset-0"
          />
        ) : (
          <CodeAgentPanel
            agent={agent}
            disabled={!!disabledReason}
            disabledReason={disabledReason}
            blackbox
            className="absolute inset-0"
          />
        )
      }
    >
      <div className="space-y-4 px-4 py-4 sm:px-6">{children}</div>
    </AuthoringShell>
  );
}
