"use client";

import * as React from "react";
import { cn } from "@/shared/lib/utils";
import { useGeneralistPanelStateOptional } from "../hooks/use-panel-state";

/**
 * Hosts the generalist agent's chat for as long as this is mounted: the chat
 * portals in here instead of opening as the side panel. The submit wizard's
 * Auto pane renders one on the steps whose agent is the generalist (Inputs,
 * Optimizer), so Auto/Manual shows and hides it like the other steps' agents.
 * Renders nothing when the agent feature is disabled.
 */
export function AgentPanelDock({ className }: { className?: string }) {
  const panel = useGeneralistPanelStateOptional();
  const [el, setEl] = React.useState<HTMLDivElement | null>(null);
  const register = panel?.registerPanelDock;
  React.useEffect(() => {
    if (!register || !el) return;
    return register(el);
  }, [register, el]);
  if (!panel) return null;
  return <div ref={setEl} className={cn("flex min-h-0", className)} />;
}
