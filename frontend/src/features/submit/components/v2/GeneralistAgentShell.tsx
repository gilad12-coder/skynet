"use client";

import * as React from "react";

import { AgentPanelDock, isGeneralistAgentEnabled } from "@/features/agent-panel";

import { AuthoringShell } from "../steps/AuthoringShell";

/**
 * The Auto/Manual frame for the steps whose agent is the app's generalist
 * (Inputs, Optimizer): Auto hosts its chat beside the step, Manual hides it,
 * the same switch and panes as the Task and Metric steps. Without the agent
 * feature the step renders bare, as there is nothing for Auto to show.
 */
export function GeneralistAgentShell({
  active,
  children,
}: {
  // Only the shown step hosts the chat: visited steps stay mounted, hidden.
  active: boolean;
  children: React.ReactNode;
}) {
  const [assist, setAssist] = React.useState<"auto" | "manual">("auto");
  if (!isGeneralistAgentEnabled())
    return <div className="flex h-full min-h-0 flex-col">{children}</div>;
  return (
    <AuthoringShell
      value={assist}
      onChange={setAssist}
      sidePanel={active ? <AgentPanelDock className="absolute inset-0" /> : null}
    >
      {children}
    </AuthoringShell>
  );
}
