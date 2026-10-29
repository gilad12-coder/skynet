"use client";

import * as React from "react";
import { cn } from "@/shared/lib/utils";
import { HelpTip } from "@/shared/ui/help-tip";

export interface AuthoringShellProps {
  // The agent chat or interview, shown in the start pane.
  sidePanel: React.ReactNode;
  // Steps that head their own body (Inputs, Optimizer) leave this out.
  title?: React.ReactNode;
  // Guidance for the step; hovering the title shows it.
  description?: string;
  children: React.ReactNode;
}

// The two-pane authoring surface of the wizard's Task and Metric steps:
// the agent pane on the start side and the editors on the end side. Callers pad their own body so a canvas can
// bleed to the edges while form fields keep the card gutter.
export function AuthoringShell({ sidePanel, title, description, children }: AuthoringShellProps) {
  return (
    <div className="@container flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-border/50 bg-card/80 backdrop-blur-xl">
      {/* The agent pane grows with the card instead of sitting at a fixed
          width, keeping a floor that fits a question and its choices; the
          editors stay the wider side. The card fills the wizard's screen, so
          once split both panes take its full height and scroll inside
          themselves. The split keys off the card's own width, not the
          viewport: beside the sidebar a 1024px iPad portrait leaves the card
          ~640px, too narrow for touch targets in both panes, so it stacks
          there (and the stack scrolls within the card) and splits from 48rem
          up. A desktop window of the same width leaves the same card, so a
          fine pointer splits from 36rem. */}
      <div
        className={cn(
          "grid min-h-0 flex-1 grid-cols-1 overflow-y-auto",
          "@3xl:grid-cols-[minmax(20rem,5fr)_minmax(0,6fr)] @3xl:grid-rows-[minmax(0,1fr)] @3xl:overflow-hidden pointer-fine:@min-[36rem]:grid-cols-[minmax(20rem,5fr)_minmax(0,6fr)] pointer-fine:@min-[36rem]:grid-rows-[minmax(0,1fr)] pointer-fine:@min-[36rem]:overflow-hidden",
        )}
      >
        <div className="relative h-[70svh] min-h-[30rem] max-h-[700px] self-stretch overflow-hidden border-b border-border/40 @3xl:h-auto @3xl:min-h-0 @3xl:max-h-none @3xl:border-b-0 @3xl:border-e pointer-fine:@min-[36rem]:h-auto pointer-fine:@min-[36rem]:min-h-0 pointer-fine:@min-[36rem]:max-h-none pointer-fine:@min-[36rem]:border-b-0 pointer-fine:@min-[36rem]:border-e">
          {sidePanel}
        </div>
        <div className="flex min-h-0 min-w-0 flex-col self-stretch">
          {title && (
            <div className="shrink-0 border-b border-border/30 px-4 py-3 sm:px-6">
              <h3 className="inline-flex text-lg font-semibold tracking-tight text-foreground">
                {description ? <HelpTip text={description}>{title}</HelpTip> : title}
              </h3>
            </div>
          )}
          {children}
        </div>
      </div>
    </div>
  );
}
