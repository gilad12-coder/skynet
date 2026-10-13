"use client";

import { PingDot } from "@/shared/ui/ping-dot";
import * as React from "react";
import { Check } from "@/shared/ui/icons";
import { msg } from "@/shared/lib/messages";
import { cn } from "@/shared/lib/utils";
import { HelpTip } from "@/shared/ui/help-tip";
import { Segmented } from "@/shared/ui/segmented";
import type { ArtifactStatus } from "@/shared/hooks/use-code-agent";

export function ArtifactStatusChip({ status }: { status: ArtifactStatus }) {
  if (status === "idle") return null;
  if (status === "waiting") {
    return (
      <span className="inline-flex items-center gap-1 text-[0.6875rem] font-medium text-muted-foreground/70">
        {msg("auto.features.submit.components.steps.codestep.4")}
        <span className="size-1.5 rounded-full bg-muted-foreground/40" />
      </span>
    );
  }
  if (status === "writing") {
    return (
      <span className="inline-flex items-center gap-1 text-[0.6875rem] font-medium text-primary">
        {msg("auto.features.submit.components.steps.codestep.5")}
        <PingDot size="sm" tone="agent" />
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[0.6875rem] font-medium text-[#5A7247] dark:text-[#adc899]">
      {msg("auto.features.submit.components.steps.codestep.6")}
      <Check className="size-3" />
    </span>
  );
}

function ModeToggle({
  value,
  onChange,
}: {
  value: "auto" | "manual";
  onChange: (mode: "auto" | "manual") => void;
}) {
  return (
    <div className="flex items-center justify-end border-b border-border/40 bg-background px-4 py-2.5">
      <Segmented<"auto" | "manual">
        size="sm"
        className="w-full sm:w-auto"
        segmentClassName="sm:px-4"
        value={value}
        onChange={onChange}
        options={[
          { value: "auto", label: msg("auto.features.submit.components.steps.codestep.7") },
          { value: "manual", label: msg("auto.features.submit.components.steps.codestep.8") },
        ]}
      />
    </div>
  );
}

export interface AuthoringShellProps {
  // Without onChange the agent pane always shows and there is no toggle: the
  // agent writes, the user edits beside it.
  value?: "auto" | "manual";
  onChange?: (mode: "auto" | "manual") => void;
  // The agent chat or interview, shown in the start pane while in auto mode.
  sidePanel: React.ReactNode;
  // Steps that head their own body (Inputs, Optimizer) leave this out.
  title?: React.ReactNode;
  // Guidance for the step; hovering the title shows it.
  description?: string;
  children: React.ReactNode;
}

// The two-pane authoring surface of the wizard's Task and Metric steps:
// an optional mode toggle header, the agent pane on the start side in auto mode, and
// the editors on the end side. Callers pad their own body so a canvas can
// bleed to the edges while form fields keep the card gutter.
export function AuthoringShell({
  value = "auto",
  onChange,
  sidePanel,
  title,
  description,
  children,
}: AuthoringShellProps) {
  return (
    <div className="@container flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-border/50 bg-card/80 backdrop-blur-xl">
      {onChange && (
        <ModeToggle value={value} onChange={onChange} />
      )}
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
          value !== "auto" && "grid-rows-[minmax(0,1fr)]",
          value === "auto" &&
            "@3xl:grid-cols-[minmax(20rem,5fr)_minmax(0,6fr)] @3xl:grid-rows-[minmax(0,1fr)] @3xl:overflow-hidden pointer-fine:@min-[36rem]:grid-cols-[minmax(20rem,5fr)_minmax(0,6fr)] pointer-fine:@min-[36rem]:grid-rows-[minmax(0,1fr)] pointer-fine:@min-[36rem]:overflow-hidden",
        )}
      >
        {value === "auto" && (
          <div className="relative h-[70svh] min-h-[30rem] max-h-[700px] self-stretch overflow-hidden border-b border-border/40 @3xl:h-auto @3xl:min-h-0 @3xl:max-h-none @3xl:border-b-0 @3xl:border-e pointer-fine:@min-[36rem]:h-auto pointer-fine:@min-[36rem]:min-h-0 pointer-fine:@min-[36rem]:max-h-none pointer-fine:@min-[36rem]:border-b-0 pointer-fine:@min-[36rem]:border-e">
            {sidePanel}
          </div>
        )}
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
