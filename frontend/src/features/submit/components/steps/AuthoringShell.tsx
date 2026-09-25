"use client";

import { PingDot } from "@/shared/ui/ping-dot";
import * as React from "react";
import { Check, Repeat } from "@/shared/ui/icons";
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
      <span className="inline-flex items-center gap-1 text-[0.6875rem] font-medium text-[#3D2E22]">
        {msg("auto.features.submit.components.steps.codestep.5")}
        <PingDot size="sm" tone="agent" />
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[0.6875rem] font-medium text-[#5A7247]">
      {msg("auto.features.submit.components.steps.codestep.6")}
      <Check className="size-3" />
    </span>
  );
}

interface ModeToggleProps {
  value: "auto" | "manual";
  onChange: (mode: "auto" | "manual") => void;
  disabledReason?: string;
  // Leading slot of the header band: the wizard's recipe chip, so the recipe
  // and the step it opens read as one card.
  start?: React.ReactNode;
  // Chip showing the chosen module with a click-to-switch affordance.
  module?: { label: string; onChangeModule: () => void } | null;
}

function ModeToggle({ value, onChange, disabledReason, start, module }: ModeToggleProps) {
  const autoDisabled = !!disabledReason && value !== "auto";

  return (
    <div className="flex flex-col items-stretch gap-2.5 border-b border-border/40 bg-[#FAF8F5] px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
      <div className="flex min-w-0 flex-col items-stretch gap-2.5 sm:flex-row sm:items-center sm:w-auto">
        {start}
        {module && (
          <button
            type="button"
            onClick={module.onChangeModule}
            data-tutorial="module-selector"
            className="group inline-flex min-h-[44px] w-full min-w-0 shrink-0 cursor-pointer items-center justify-between gap-1.5 rounded-md border border-border/60 bg-background px-2 py-1 text-xs shadow-xs transition-colors hover:border-[#C8A882] sm:w-auto lg:min-h-0"
          >
            <span className="font-semibold text-foreground">{module.label}</span>
            <span aria-hidden className="h-3 w-px bg-border/70" />
            <span className="flex items-center gap-1 font-medium text-muted-foreground transition-colors group-hover:text-foreground">
              {msg("submit.module.change")}
              <Repeat className="size-3" />
            </span>
          </button>
        )}
      </div>

      <Segmented<"auto" | "manual">
        size="sm"
        className="w-full sm:w-auto"
        segmentClassName="sm:px-4"
        value={value}
        onChange={onChange}
        options={[
          {
            value: "auto",
            label: msg("auto.features.submit.components.steps.codestep.7"),
            disabled: autoDisabled,
            title: autoDisabled ? disabledReason : undefined,
          },
          { value: "manual", label: msg("auto.features.submit.components.steps.codestep.8") },
        ]}
      />
    </div>
  );
}

export interface AuthoringShellProps extends ModeToggleProps {
  // The agent chat or interview, shown in the start pane while in auto mode.
  sidePanel: React.ReactNode;
  title: React.ReactNode;
  // Guidance for the step; hovering the title shows it.
  description?: string;
  children: React.ReactNode;
}

// The two-pane authoring surface shared by the DSPy and black-box wizards:
// a mode toggle header, the agent pane on the start side in auto mode, and
// the editors on the end side. Callers pad their own body so a canvas can
// bleed to the edges while form fields keep the card gutter.
export function AuthoringShell({
  value,
  onChange,
  disabledReason,
  start,
  module,
  sidePanel,
  title,
  description,
  children,
}: AuthoringShellProps) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border/50 bg-card/80 backdrop-blur-xl shadow-lg">
      <ModeToggle
        value={value}
        onChange={onChange}
        disabledReason={disabledReason}
        start={start}
        module={module}
      />
      {/* The agent pane grows with the card instead of sitting at a fixed
          width, keeping a floor that fits a question and its choices; the
          editors stay the wider side. On desktop the pane also sets the
          card's height: it reaches the nav (22rem is the stepper, header
          band, nav and page paddings around it) but never drops under
          56rem, so a conversation and a long brief both have room. */}
      <div
        className={cn(
          "grid grid-cols-1",
          value === "auto" && "lg:grid-cols-[minmax(20rem,5fr)_minmax(0,6fr)]",
        )}
      >
        {value === "auto" && (
          <div className="relative h-[70svh] min-h-[30rem] max-h-[700px] self-stretch overflow-hidden border-b border-border/40 lg:h-auto lg:min-h-[max(56rem,calc(100svh-22rem))] lg:max-h-none lg:border-b-0 lg:border-e">
            {sidePanel}
          </div>
        )}
        <div className="flex min-w-0 flex-col self-stretch">
          <div className="shrink-0 border-b border-border/30 px-4 py-3 sm:px-6">
            <h3 className="inline-flex text-lg font-semibold tracking-tight text-foreground">
              {description ? <HelpTip text={description}>{title}</HelpTip> : title}
            </h3>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
