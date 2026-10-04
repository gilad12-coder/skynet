"use client";

import * as React from "react";
import { Check, CaretDown, CaretRight } from "@/shared/ui/icons";

import { cachedCatalog, getModelCatalog } from "@/shared/lib/model-catalog";
import { effortLabel, effortsFor } from "@/shared/lib/model-efforts";
import { msg } from "@/shared/lib/messages";
import { cn } from "@/shared/lib/utils";
import { ProviderLogo } from "@/shared/ui/provider-logo";
import { modelProviderSlug } from "@/shared/lib/model-provider";
import type { ModelCatalogResponse } from "@/shared/types/api";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/shared/ui/primitives/dropdown-menu";

interface ComposerModelMenuProps {
  /** LiteLLM id of the chosen model; ``null`` runs the catalog's default. */
  value: string | null;
  onChange: (model: string | null) => void;
  /** Reasoning-effort level for the chosen model; ``null`` runs its default. */
  effort: string | null;
  onEffortChange: (effort: string | null) => void;
  disabled?: boolean;
}

/** Short display name for a LiteLLM id ("openai/gpt-4o-mini" → "gpt-4o-mini"). */
function shortName(id: string): string {
  return id.split("/").pop() || id;
}

// The retired "Auto · Intelligent" entry; saved prefs and conversations may
// still carry it, and the backend runs the default for it like for null.
const RETIRED_AUTO_MODEL = "auto:intelligent";

// Caps the fallback list when the catalog flags no featured models (an
// on-prem gateway whose listing carries no release dates or benchmarks).
const FALLBACK_LIST_CAP = 50;

function effortHint(level: string | null): string {
  switch (level) {
    case "none":
      return msg("agent.model_menu.effort_none_hint");
    case "minimal":
      return msg("agent.model_menu.effort_minimal_hint");
    case "low":
      return msg("agent.model_menu.effort_low_hint");
    case "medium":
      return msg("agent.model_menu.effort_medium_hint");
    case "high":
      return msg("agent.model_menu.effort_high_hint");
    case "xhigh":
      return msg("agent.model_menu.effort_xhigh_hint");
    case "max":
      return msg("agent.model_menu.effort_max_hint");
    default:
      return msg("agent.model_menu.effort_default_hint");
  }
}

/**
 * The composer's model menu, structured like Codex's: a quiet chip naming the
 * current choice ("gpt-5 High") opens a compact two-row menu — Model and
 * Thinking level, each showing its current value — and each row fans out a
 * side submenu with the checkmarked options. Picking anything closes the
 * whole menu; the choice applies from the next turn of the surrounding
 * conversation. The thinking row is visible but inert on models without
 * reasoning support. The model submenu shows only the featured shortlist
 * the catalog derives from provider metadata.
 */
export function ComposerModelMenu({
  value: rawValue,
  onChange,
  effort,
  onEffortChange,
  disabled,
}: ComposerModelMenuProps) {
  const savedValue = rawValue === RETIRED_AUTO_MODEL ? null : rawValue;
  const [open, setOpen] = React.useState(false);
  const [catalog, setCatalog] = React.useState<ModelCatalogResponse | null>(
    cachedCatalog() ?? null,
  );
  // The synchronous cache may be stale (served without a TTL so the menu is
  // never empty) — always adopt the revalidated catalog when it lands.
  React.useEffect(() => {
    let cancelled = false;
    getModelCatalog()
      .then((c) => {
        if (!cancelled) setCatalog(c);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const available = React.useMemo(
    () => (catalog?.models ?? []).filter((m) => m.available),
    [catalog],
  );
  // A saved pick the live catalog no longer lists (a withdrawn model) would
  // name a dead id on the chip. Only judged against a loaded, non-empty
  // catalog so a gateway outage never wipes a valid pick.
  const stale =
    !!savedValue &&
    !!catalog &&
    catalog.models.length > 0 &&
    !catalog.models.some((m) => m.value === savedValue);
  const value = savedValue && !stale ? savedValue : null;
  React.useEffect(() => {
    if (stale) {
      onChange(null);
      onEffortChange(null);
    }
  }, [stale, onChange, onEffortChange]);

  // The backend flags each leading lab's newest models from provider
  // metadata. A gateway that flags none falls back to the plain list rather
  // than an empty menu.
  const featured = React.useMemo(() => {
    const rows = available.filter((m) => m.featured);
    return rows.length ? rows : available.slice(0, FALLBACK_LIST_CAP);
  }, [available]);
  // A previously chosen model outside the shortlist keeps its checkmarked
  // row next time the menu opens.
  const currentExtra =
    value && !featured.some((m) => m.value === value)
      ? (available.find((m) => m.value === value) ?? null)
      : null;

  // No pick runs the catalog's flagged default, so the chip names it and its
  // efforts apply.
  const catalogDefault = available.find((m) => m.is_default) ?? null;
  const effective = value ?? catalogDefault?.value ?? null;
  const displayName = effective ? shortName(effective) : msg("agent.model_menu.effort_default");
  const current = available.find((m) => m.value === effective);
  const canThink = !!current?.supports_thinking;
  const efforts = effortsFor(effective, available);
  // An off-by-default thinker runs "Default" with no reasoning at all, so it
  // has no default level to name.
  const defaultEffort = current?.reasoning_default_enabled
    ? (current.default_reasoning_effort ?? null)
    : null;

  const pick = (model: string | null) => {
    onChange(model);
    // Effort only means something on a reasoning-capable model, and each
    // provider speaks its own vocabulary — carrying a level the new model
    // doesn't support would send a dead or rejected parameter.
    const target = model ?? catalogDefault?.value ?? null;
    if (
      !target ||
      !available.find((m) => m.value === target)?.supports_thinking ||
      (effort !== null && !effortsFor(target, available).includes(effort))
    ) {
      onEffortChange(null);
    }
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={msg("agent.model_menu.label")}
          className={cn(
            "flex h-[44px] max-w-[110px] min-w-0 items-center gap-1.5 rounded-full px-3 text-xs text-foreground sm:h-9 sm:max-w-none [@media(hover:none)_and_(pointer:coarse)]:h-[44px]",
            "cursor-pointer transition-colors hover:bg-accent/60",
            "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40",
            "disabled:pointer-events-none disabled:opacity-50",
            open && "bg-accent/60",
          )}
        >
          {effective && <ProviderLogo slug={modelProviderSlug(effective)} size={16} />}
          <span className="min-w-0 max-w-20 truncate font-medium sm:max-w-40" dir="ltr">
            {displayName}
          </span>
          {/* Codex-style chip: the effort reads as a lighter suffix after the
              model name ("gpt-5 High"), not a separated fragment. */}
          {effective && effort && (
            <span className="shrink-0 text-muted-foreground">{effortLabel(effort)}</span>
          )}
          <CaretDown className="size-3 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={6} className="w-64">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="py-2.5">
            <span className="shrink-0">{msg("agent.model_menu.model")}</span>
            <span className="ms-auto truncate text-muted-foreground" dir="ltr">
              {displayName}
            </span>
            <CaretRight className="size-3.5 shrink-0 text-muted-foreground rtl:rotate-180" />
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-72 overflow-hidden p-0">
            <div className="max-h-[min(18rem,var(--radix-dropdown-menu-content-available-height))] overflow-y-auto py-1">
              {currentExtra && (
                <MenuItem
                  selected
                  label={shortName(currentExtra.value)}
                  icon={<ProviderLogo slug={modelProviderSlug(currentExtra.value)} size={16} />}
                  onSelect={() => pick(currentExtra.value)}
                />
              )}
              {featured.map((m) => (
                <MenuItem
                  key={m.value}
                  selected={effective === m.value}
                  label={shortName(m.value)}
                  icon={<ProviderLogo slug={modelProviderSlug(m.value)} size={16} />}
                  onSelect={() => pick(m.value)}
                />
              ))}
            </div>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={!canThink || efforts.length === 0} className="py-2.5">
            <span className="shrink-0">{msg("agent.model_menu.effort_label")}</span>
            <span className="ms-auto truncate text-muted-foreground">
              {effort ? effortLabel(effort) : msg("agent.model_menu.effort_default")}
            </span>
            <CaretRight className="size-3.5 shrink-0 text-muted-foreground rtl:rotate-180" />
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-60">
            {[null, ...efforts].map((level) => (
              <MenuItem
                key={level ?? "default"}
                selected={effort === level}
                label={level ? effortLabel(level) : msg("agent.model_menu.effort_default")}
                description={
                  level === null && defaultEffort
                    ? msg("agent.model_menu.effort_default_level", {
                        level: effortLabel(defaultEffort),
                      })
                    : effortHint(level)
                }
                dir="auto"
                onSelect={() => onEffortChange(level)}
              />
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MenuItem({
  selected,
  label,
  description,
  icon,
  onSelect,
  dir = "ltr",
}: {
  selected: boolean;
  label: string;
  description?: string;
  icon?: React.ReactNode;
  onSelect: () => void;
  /** Model ids are latin so rows default LTR; localized rows pass ``auto``. */
  dir?: "ltr" | "auto";
}) {
  return (
    <DropdownMenuItem onSelect={onSelect}>
      {icon}
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          className={cn("truncate text-sm text-foreground", selected && "font-medium")}
          dir={dir}
        >
          {label}
        </span>
        {/* Descriptions are localized even on LTR model-id rows — let the
            text pick its own direction so Hebrew copy orders correctly. */}
        {description && (
          <span className="truncate text-xs text-muted-foreground" dir="auto">
            {description}
          </span>
        )}
      </span>
      <Check className={cn("size-4 shrink-0 text-primary", !selected && "invisible")} />
    </DropdownMenuItem>
  );
}
