"use client";

import * as React from "react";
import { Check, Repeat } from "@/shared/ui/icons";
import { msg } from "@/shared/lib/messages";
import { cn } from "@/shared/lib/utils";
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
        <span className="size-1.5 rounded-full bg-[#3D2E22] animate-pulse" />
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

export interface ModeToggleProps {
  value: "auto" | "manual";
  onChange: (mode: "auto" | "manual") => void;
  disabledReason?: string;
  // Chip showing the chosen module with a click-to-switch affordance.
  module?: { label: string; onChangeModule: () => void } | null;
}

export function ModeToggle({ value, onChange, disabledReason, module }: ModeToggleProps) {
  const autoDisabled = !!disabledReason && value !== "auto";

  return (
    <div className="flex flex-col items-stretch gap-2.5 border-b border-border/40 bg-[#FAF8F5] px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
      <div className="flex min-w-0 items-center gap-2.5 sm:w-auto">
        {module && (
          <button
            type="button"
            onClick={module.onChangeModule}
            data-tutorial="module-selector"
            className="group inline-flex min-h-[44px] w-full min-w-0 shrink-0 cursor-pointer items-center justify-between gap-1.5 rounded-md border border-border/60 bg-background px-2 py-1 text-xs shadow-xs transition-colors hover:border-[#C8A882] sm:w-auto lg:min-h-0"
          >
            <span className="font-semibold text-foreground">{module.label}</span>
            <span aria-hidden className="h-3 w-px bg-border/80" />
            <span className="flex items-center gap-1 font-medium text-muted-foreground transition-colors group-hover:text-foreground">
              {msg("submit.module.change")}
              <Repeat className="size-3" />
            </span>
          </button>
        )}
      </div>

      <div className="relative inline-grid w-full [grid-template-columns:repeat(2,minmax(0,1fr))] gap-1 rounded-lg bg-muted p-1 sm:w-auto">
        <div
          aria-hidden
          className="absolute top-1 bottom-1 w-[calc(50%-6px)] rounded-md bg-background shadow-sm transition-[inset-inline-start] duration-150 ease-out pointer-events-none"
          style={{ insetInlineStart: value === "auto" ? 4 : "calc(50% + 2px)" }}
        />
        <button
          type="button"
          onClick={() => onChange("auto")}
          disabled={autoDisabled}
          title={autoDisabled ? disabledReason : undefined}
          aria-pressed={value === "auto"}
          className={cn(
            "relative z-[1] min-h-[44px] cursor-pointer rounded-md px-3 py-1 text-center text-xs font-medium leading-none transition-colors sm:px-4 lg:min-h-0",
            value === "auto" ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            autoDisabled && "opacity-40 cursor-not-allowed hover:text-muted-foreground",
          )}
        >
          {msg("auto.features.submit.components.steps.codestep.7")}
        </button>
        <button
          type="button"
          onClick={() => onChange("manual")}
          aria-pressed={value === "manual"}
          className={cn(
            "relative z-[1] min-h-[44px] cursor-pointer rounded-md px-3 py-1 text-center text-xs font-medium leading-none transition-colors sm:px-4 lg:min-h-0",
            value === "manual" ? "text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {msg("auto.features.submit.components.steps.codestep.8")}
        </button>
      </div>
    </div>
  );
}

export interface AuthoringShellProps extends ModeToggleProps {
  // The agent chat or interview, shown in the start pane while in auto mode.
  sidePanel: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
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
        module={module}
      />
      <div
        className={cn("grid grid-cols-1", value === "auto" && "lg:grid-cols-[400px_minmax(0,1fr)]")}
      >
        {value === "auto" && (
          <div className="relative h-[70svh] min-h-[30rem] max-h-[700px] self-stretch overflow-hidden border-b border-border/40 lg:h-auto lg:min-h-[700px] lg:max-h-none lg:border-b-0 lg:border-e">
            {sidePanel}
          </div>
        )}
        <div className="flex min-w-0 flex-col self-stretch">
          <div className="shrink-0 border-b border-border/30 px-4 py-3 sm:px-6">
            <h3 className="inline-flex text-lg font-semibold tracking-tight text-foreground">
              {title}
            </h3>
            {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
