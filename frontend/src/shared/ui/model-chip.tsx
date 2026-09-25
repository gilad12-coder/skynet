"use client";

import * as React from "react";
import {
  Copy,
  Trash,
  Plus,
  Thermometer,
  TextT,
  Eye,
  Brain,
  Info,
  Coins,
  Key,
} from "@/shared/ui/icons";
import { cn } from "@/shared/lib/utils";
import type { CatalogModel, ModelConfig } from "@/shared/types/api";
import { msg } from "@/shared/lib/messages";
import { getActiveDir } from "@/shared/lib/runtime-locale";
import { Button } from "@/shared/ui/primitives/button";
import { TooltipButton } from "@/shared/ui/tooltip-button";
import { ProviderLogo } from "@/shared/ui/provider-logo";
import { modelProviderSlug } from "@/shared/lib/model-provider";

interface ModelChipProps {
  config: ModelConfig;
  /** Names the role for assistive tech; the surface shows it above the chip. */
  roleLabel?: string;
  /** Hide sampling and reasoning settings when the runtime owns them. */
  modelDefaultsOnly?: boolean;
  onClick: () => void;
  onClone?: () => void;
  onRemove?: () => void;
  /** If true, shows a subtle "required" style */
  required?: boolean;
  /** Catalog used to resolve a model's vision capability for the badge. */
  catalogModels?: CatalogModel[];
  /** Placeholder when no model is set; overrides the required/not-configured copy. */
  emptyLabel?: string;
  /** Explanation shown when hovering or focusing the card's Info button. */
  tooltip?: string | null;
  className?: string;
}

const REASONING_EFFORT_LABELS: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
};

function reasoningEffortLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  return REASONING_EFFORT_LABELS[value.toLowerCase()] ?? value;
}

/** Tiny model capability pill (reasoning, token source, vision). */
export function MicroPill({
  tone = "muted",
  className,
  ...props
}: React.ComponentProps<"span"> & { tone?: "muted" | "primary" }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[9px] font-semibold",
        tone === "primary" ? "bg-primary/10 text-primary" : "bg-muted/50 text-muted-foreground/80",
        className,
      )}
      {...props}
    />
  );
}

function ReasoningPill({ value }: { value: string | null | undefined }) {
  const label = reasoningEffortLabel(value);
  if (!label) return null;
  return (
    <MicroPill title={`Reasoning effort: ${label}`}>
      <Brain className="size-2.5" />
      {label}
    </MicroPill>
  );
}

function TokenSourcePill({ source }: { source: ModelConfig["token_source"] }) {
  // Keep this to a compact echo; the dialog owns the explanation and provider management.
  if (!source) return null;
  const byok = source === "byok";
  const Icon = byok ? Key : Coins;
  const label = msg(byok ? "billing.mode.byok" : "billing.mode.managed");
  return (
    <MicroPill title={label} dir="auto">
      <Icon className="size-2.5" aria-hidden="true" />
      {label}
    </MicroPill>
  );
}

export function ModelChip({
  config,
  roleLabel,
  modelDefaultsOnly = false,
  onClick,
  onClone,
  onRemove,
  required,
  catalogModels,
  emptyLabel,
  tooltip,
  className,
}: ModelChipProps) {
  const effort = modelDefaultsOnly
    ? undefined
    : (config.extra?.reasoning_effort as string | undefined);
  const temperature = modelDefaultsOnly ? undefined : config.temperature;
  const maxTokens = modelDefaultsOnly ? undefined : config.max_tokens;
  const name =
    config.name ||
    emptyLabel ||
    (required ? msg("shared.model_chip.choose_model") : msg("shared.model_chip.not_configured"));
  const isEmpty = !config.name;
  const supportsVision = !!catalogModels?.find((m) => m.value === config.name)?.supports_vision;

  const content = (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span
        className={cn(
          "truncate text-sm",
          isEmpty ? "text-muted-foreground" : "text-foreground font-mono font-medium",
        )}
        // Placeholder text is localized, so it follows the active direction;
        // a concrete model id is always Latin and stays LTR.
        dir={isEmpty ? getActiveDir() : "ltr"}
      >
        {isEmpty ? name : (name.split("/").pop() ?? name)}
      </span>
      {/* A config that carries only a model id (e.g. the tagger's tagging
            model) renders no parameter row at all — a fabricated temperature
            would read as a setting the surface doesn't actually have. */}
      {!isEmpty &&
        (temperature != null ||
          maxTokens != null ||
          effort ||
          supportsVision ||
          config.token_source) && (
          <div
            className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[0.625rem] text-muted-foreground"
            dir="ltr"
          >
            {temperature != null && (
              <span
                className="inline-flex items-center gap-0.5"
                title={msg("auto.features.submit.components.modelconfigmodal.5")}
              >
                <Thermometer className="size-2.5" />
                {temperature}
              </span>
            )}
            {maxTokens != null && (
              <span
                className="inline-flex items-center gap-0.5"
                title={msg("auto.features.submit.components.modelconfigmodal.7")}
              >
                <TextT className="size-2.5" aria-hidden="true" />
                {maxTokens}
              </span>
            )}
            {effort && <ReasoningPill value={effort} />}
            <TokenSourcePill source={config.token_source} />
            {supportsVision && (
              <MicroPill tone="primary" title={msg("shared.model_chip.vision_badge")}>
                <Eye className="size-2.5" />
              </MicroPill>
            )}
          </div>
        )}
    </div>
  );

  const card = (
    <div
      className={cn(
        "group relative flex items-center gap-2.5 rounded-lg border px-3 py-2 cursor-pointer",
        "transition-[border-color,box-shadow,background-color] duration-150",
        isEmpty
          ? "border-dashed border-border/60 bg-muted/20 hover:border-primary/40 hover:bg-muted/40"
          : "border-border/50 bg-card/80 hover:border-primary/40 hover:shadow-sm",
        className,
      )}
    >
      <button
        type="button"
        onClick={onClick}
        aria-haspopup="dialog"
        aria-label={roleLabel ? `${roleLabel}: ${name}` : name}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-start outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {!isEmpty && <ProviderLogo slug={modelProviderSlug(config.name)} size={24} />}
        {content}
      </button>

      <div className="flex shrink-0 items-center gap-1">
        {tooltip && (
          <TooltipButton
            tooltip={tooltip}
            side="top"
            dir={getActiveDir()}
            contentClassName="max-w-64 text-center leading-relaxed"
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={tooltip}
              onClick={(e) => e.stopPropagation()}
              className="text-muted-foreground hover:text-foreground"
            >
              <Info className="size-3.5" aria-hidden="true" />
            </Button>
          </TooltipButton>
        )}
        {onClone && !isEmpty && (
          <TooltipButton tooltip={msg("shared.model_chip.clone")} side="top">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={msg("shared.model_chip.clone")}
              onClick={(e) => {
                e.stopPropagation();
                onClone();
              }}
              className="text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-foreground"
            >
              <Copy className="size-3.5" />
            </Button>
          </TooltipButton>
        )}
        {onRemove && !isEmpty && (
          <TooltipButton tooltip={msg("shared.model_chip.remove")} side="top">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={msg("shared.model_chip.remove")}
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
              className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash className="size-3.5" />
            </Button>
          </TooltipButton>
        )}
      </div>
    </div>
  );

  return card;
}

interface AddModelButtonProps {
  label?: string;
  onClick: () => void;
  className?: string;
}

export function AddModelButton({
  label = msg("shared.model_chip.add_model"),
  onClick,
  className,
}: AddModelButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 rounded-lg border border-dashed border-border/50 px-3 py-2",
        "text-sm text-muted-foreground hover:border-primary/40 hover:text-foreground hover:bg-muted/30",
        "transition-all duration-150 cursor-pointer",
        className,
      )}
    >
      <Plus className="size-3.5" />
      {label}
    </button>
  );
}
