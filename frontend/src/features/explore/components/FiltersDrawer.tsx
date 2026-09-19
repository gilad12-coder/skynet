"use client";

import * as React from "react";
import {
  CalendarBlank,
  Check,
  Cpu,
  Cube,
  MagnifyingGlass,
  Stack,
  Target,
  X,
} from "@/shared/ui/icons";
import type { FacetOption } from "@/shared/lib/api";
import { modelDisplayName } from "@/shared/lib/formatters";
import { msg, formatMsg } from "@/shared/lib/messages";
import { getActiveDir } from "@/shared/lib/runtime-locale";
import { useIsPhone } from "@/shared/hooks/use-device-class";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/shared/ui/primitives/sheet";
import { SkynetDatePicker } from "@/shared/ui/skynet-date-picker";
import { engineDisplayName } from "../lib/format";
import { isCollapsible, isExhausted, visibleOptions } from "../lib/facet-options";

interface FiltersDrawerProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  /**
   * Every value present in the corpus for each dimension, sorted by value by
   * the caller, each with the number of runs it would leave alongside the
   * other active filters (0 = ruled out by the current selection).
   */
  modelOptions: FacetOption[];
  optimizerOptions: FacetOption[];
  moduleOptions: FacetOption[];
  /** Run-type counts; an empty list means counts are unknown and every type stays selectable. */
  typeOptions: FacetOption[];
  /** Currently active filter values. */
  selectedModels: string[];
  selectedOptimizers: string[];
  selectedTypes: string[];
  selectedModules: string[];
  dateFrom: string | null;
  dateTo: string | null;
  onChangeModels: (next: string[]) => void;
  onChangeOptimizers: (next: string[]) => void;
  onChangeTypes: (next: string[]) => void;
  onChangeModules: (next: string[]) => void;
  onChangeDateRange: (from: string | null, to: string | null) => void;
  /** Wipes every filter inside the drawer (excluding free-text query). */
  onClearAll: () => void;
}

const TYPE_VALUES: ReadonlyArray<{
  value: string;
  labelKey: Parameters<typeof msg>[0];
}> = [
  { value: "run", labelKey: "explore.filter.run" },
  { value: "grid_search", labelKey: "explore.filter.grid" },
  { value: "blackbox", labelKey: "explore.filter.blackbox" },
];

/**
 * Slide-in panel for structured filtering on top of the free-text query.
 * Every section is a chip group — a dropdown would hide both the options and
 * the current selection behind a click, and no dimension here is wide enough
 * to need that. Each chip carries the number of runs it would leave with the
 * other active filters, so the drawer itself shows which combinations exist:
 * zero-count chips grey out instead of leading to an empty result, and long
 * lists (models) collapse to their busiest values behind a search box and a
 * "show all" toggle. Date inputs use the project's custom calendar to stay
 * consistent with the rest of the visual system.
 */
export function FiltersDrawer({
  open,
  onOpenChange,
  modelOptions,
  optimizerOptions,
  moduleOptions,
  typeOptions,
  selectedModels,
  selectedOptimizers,
  selectedTypes,
  selectedModules,
  dateFrom,
  dateTo,
  onChangeModels,
  onChangeOptimizers,
  onChangeTypes,
  onChangeModules,
  onChangeDateRange,
  onClearAll,
}: FiltersDrawerProps) {
  const totalActive =
    selectedModels.length +
    selectedOptimizers.length +
    selectedTypes.length +
    selectedModules.length +
    (dateFrom ? 1 : 0) +
    (dateTo ? 1 : 0);
  const isRtl = getActiveDir() === "rtl";
  // A section's counts are only "ruled out by the other filters" when there
  // are other filters; with none active, zero counts mean the scope is empty.
  const othersActive = (own: number) => totalActive - own > 0;
  // Run types render in a fixed order with the fetched count attached; an
  // empty fetch (loading, error) leaves counts unknown rather than zero.
  const typeChips = React.useMemo<FacetOption[]>(() => {
    if (typeOptions.length === 0) return TYPE_VALUES.map((t) => ({ value: t.value, count: -1 }));
    return TYPE_VALUES.map((t) => ({
      value: t.value,
      count: typeOptions.find((o) => o.value === t.value)?.count ?? 0,
    }));
  }, [typeOptions]);
  // Phones get a bottom sheet capped below the top edge; desktop keeps the
  // side drawer on the reading-end edge.
  const isPhone = useIsPhone();

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={isPhone ? "bottom" : isRtl ? "left" : "right"}
        showCloseButton={false}
        className={
          isPhone
            ? "max-h-[85dvh] w-full gap-0 rounded-t-2xl border-border bg-background p-0 pb-[env(safe-area-inset-bottom)]"
            : "w-full !max-w-md gap-0 border-border bg-background p-0"
        }
      >
        <div className="flex h-full min-h-0 flex-col">
          <SheetHeader className="flex-row items-start justify-between gap-3 border-b border-border/60 px-6 py-5">
            <div className="flex flex-col gap-1.5">
              <SheetTitle className="text-[17px] font-medium tracking-tight text-foreground">
                {msg("explore.filters.title")}
              </SheetTitle>
              <SheetDescription className="text-[12.5px] leading-relaxed text-foreground/55">
                {msg("explore.filters.subtitle")}
              </SheetDescription>
            </div>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              aria-label={msg("explore.filters.close")}
              className="inline-flex size-[44px] shrink-0 cursor-pointer items-center justify-center rounded-lg text-foreground/55 transition-[background-color,color] hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C8A882]/45 lg:size-9"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto px-6 py-6">
            {/* Two clusters, each held tighter (gap-7) than the space between
                them (gap-10): the optimization itself (program, model,
                optimizer), then the run's own metadata (kind, date). */}
            <div className="flex flex-col gap-10">
              <div className="flex flex-col gap-7">
                <FacetSection
                  title={msg("explore.filters.section.modules")}
                  icon={Cube}
                  options={moduleOptions}
                  selected={selectedModules}
                  othersActive={othersActive(selectedModules.length)}
                  onToggle={(v) => onChangeModules(toggleValue(selectedModules, v))}
                  dir="auto"
                />

                <FacetSection
                  title={msg("explore.filters.section.models")}
                  icon={Cpu}
                  options={modelOptions}
                  selected={selectedModels}
                  othersActive={othersActive(selectedModels.length)}
                  onToggle={(v) => onChangeModels(toggleValue(selectedModels, v))}
                  labelOf={modelDisplayName}
                  dir="ltr"
                />

                <FacetSection
                  title={msg("explore.filters.section.optimizers")}
                  icon={Target}
                  options={optimizerOptions}
                  selected={selectedOptimizers}
                  othersActive={othersActive(selectedOptimizers.length)}
                  onToggle={(v) => onChangeOptimizers(toggleValue(selectedOptimizers, v))}
                  labelOf={engineDisplayName}
                  dir="ltr"
                />
              </div>

              <div className="flex flex-col gap-7">
                <FacetSection
                  title={msg("explore.filters.section.types")}
                  icon={Stack}
                  options={typeChips}
                  selected={selectedTypes}
                  othersActive={othersActive(selectedTypes.length)}
                  onToggle={(v) => onChangeTypes(toggleValue(selectedTypes, v))}
                  labelOf={typeLabel}
                  dir="auto"
                />

                <FilterSection
                  title={msg("explore.filters.section.date")}
                  icon={CalendarBlank}
                  selectedCount={(dateFrom ? 1 : 0) + (dateTo ? 1 : 0)}
                >
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <DateRangeField
                      label={msg("explore.filters.date.from")}
                      value={dateFrom}
                      max={dateTo ?? undefined}
                      onChange={(v) => onChangeDateRange(v, dateTo)}
                    />
                    <DateRangeField
                      label={msg("explore.filters.date.to")}
                      value={dateTo}
                      min={dateFrom ?? undefined}
                      onChange={(v) => onChangeDateRange(dateFrom, v)}
                    />
                  </div>
                </FilterSection>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-border/60 bg-background px-6 py-4">
            <button
              type="button"
              onClick={onClearAll}
              disabled={totalActive === 0}
              className="inline-flex items-center justify-center rounded-lg px-3 py-2 text-[13px] text-foreground/65 transition-[background-color,color] cursor-pointer hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:text-foreground/30 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C8A882]/45"
            >
              {msg("explore.filters.clear")}
            </button>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="inline-flex items-center justify-center rounded-lg bg-foreground px-4 py-2 text-[13px] font-medium text-background transition-colors cursor-pointer hover:bg-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C8A882]/45"
            >
              {msg("explore.filters.apply")}
            </button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function toggleValue(current: string[], value: string): string[] {
  return current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
}

function typeLabel(value: string): string {
  const entry = TYPE_VALUES.find((t) => t.value === value);
  return entry ? msg(entry.labelKey) : value;
}

type IconComponent = React.ComponentType<{
  className?: string;
  "aria-hidden"?: boolean | "true";
}>;

function FilterSection({
  title,
  icon: Icon,
  selectedCount = 0,
  children,
}: {
  title: string;
  icon?: IconComponent;
  selectedCount?: number;
  children: React.ReactNode;
}) {
  const active = selectedCount > 0;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h3
          className={`inline-flex items-center gap-2 text-[12px] font-medium tracking-wide transition-colors ${
            active ? "text-foreground/80" : "text-foreground/55"
          }`}
        >
          {Icon && (
            <Icon
              className={`size-3.5 transition-colors ${
                active ? "text-foreground/70" : "text-foreground/45"
              }`}
              aria-hidden="true"
            />
          )}
          <span>{title}</span>
        </h3>
        {active && (
          <span
            className="rounded-full bg-foreground/[0.06] px-1.5 py-0.5 text-[10.5px] font-medium tabular-nums text-foreground/60"
            aria-label={formatMsg(
              selectedCount === 1
                ? "explore.filters.section.selected"
                : "explore.filters.section.selected_many",
              { n: selectedCount },
            )}
          >
            {formatMsg(
              selectedCount === 1
                ? "explore.filters.section.selected"
                : "explore.filters.section.selected_many",
              { n: selectedCount },
            )}
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

function FacetSection({
  title,
  icon,
  options,
  selected,
  othersActive,
  onToggle,
  labelOf = (v) => v,
  dir,
}: {
  title: string;
  icon?: IconComponent;
  options: FacetOption[];
  selected: string[];
  /** Whether any filter outside this section is active (counts then mean "ruled out"). */
  othersActive: boolean;
  onToggle: (value: string) => void;
  labelOf?: (value: string) => string;
  dir: "ltr" | "rtl" | "auto";
}) {
  const [query, setQuery] = React.useState("");
  const [expanded, setExpanded] = React.useState(false);
  const collapsible = isCollapsible(options);
  const trimmed = query.trim();

  const visible = React.useMemo(
    () => visibleOptions(options, selected, { expanded, query: trimmed, labelOf }),
    [options, selected, expanded, trimmed, labelOf],
  );
  const exhausted = othersActive && selected.length === 0 && isExhausted(options);

  return (
    <FilterSection title={title} icon={icon} selectedCount={selected.length}>
      {collapsible && (
        <SectionSearchInput
          value={query}
          onChange={setQuery}
          placeholder={formatMsg("explore.filters.section.search", {
            section: title,
          })}
        />
      )}
      {visible.length === 0 ? (
        <p className="text-[12.5px] text-foreground/45">
          {trimmed
            ? msg("explore.filters.section.no_search_match")
            : msg("explore.filters.empty_section")}
        </p>
      ) : (
        <ChipGroup
          options={visible}
          selected={selected}
          onToggle={onToggle}
          labelOf={labelOf}
          dir={dir}
        />
      )}
      {exhausted && (
        <p className="text-[12px] text-foreground/45">
          {msg("explore.filters.section.none_in_selection")}
        </p>
      )}
      {collapsible && !trimmed && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="self-start text-[12px] text-foreground/60 underline-offset-4 transition-colors cursor-pointer hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C8A882]/45"
        >
          {expanded
            ? msg("explore.filters.section.show_fewer")
            : formatMsg("explore.filters.section.show_all", { n: options.length })}
        </button>
      )}
    </FilterSection>
  );
}

function SectionSearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative">
      <MagnifyingGlass
        className="pointer-events-none absolute end-2.5 top-1/2 size-3.5 -translate-y-1/2 text-foreground/40"
        aria-hidden="true"
      />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        dir="auto"
        className="w-full rounded-lg border border-border bg-background ps-3 pe-8 py-1.5 text-[12.5px] text-foreground placeholder:text-foreground/40 transition-colors hover:border-foreground/30 focus:border-foreground/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#C8A882]/45"
      />
    </div>
  );
}

function ChipGroup({
  options,
  selected,
  onToggle,
  labelOf,
  dir,
}: {
  options: FacetOption[];
  selected: string[];
  onToggle: (value: string) => void;
  labelOf: (value: string) => string;
  /**
   * Per-chip text direction. LTR for code identifiers, RTL for Hebrew labels,
   * auto for user-authored names that may be either (tasks, modules).
   */
  dir: "ltr" | "rtl" | "auto";
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map(({ value, count }) => {
        const active = selected.includes(value);
        const label = labelOf(value);
        return (
          <SelectableChip
            key={value}
            label={label}
            // Trimmed labels (e.g. bare model names) keep the full value
            // reachable on hover — providers can collide on the short name.
            title={label === value ? undefined : value}
            // A negative count means unknown (facets not loaded); hide it.
            count={count < 0 ? null : count}
            active={active}
            dir={dir}
            onClick={() => onToggle(value)}
          />
        );
      })}
    </div>
  );
}

function SelectableChip({
  label,
  title,
  count,
  active,
  dir,
  onClick,
}: {
  label: string;
  title?: string;
  count: number | null;
  active: boolean;
  dir: "ltr" | "rtl" | "auto";
  onClick: () => void;
}) {
  // A selected chip always stays clickable so it can be removed; only an
  // unselected value the other filters rule out is taken off the table.
  const unavailable = !active && count === 0;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      disabled={unavailable}
      title={title}
      dir={dir}
      className={`group inline-flex min-h-[44px] max-w-full items-center gap-1 rounded-full border px-3 py-1.5 text-[12.5px] transition-[background-color,border-color,color,opacity] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C8A882]/45 lg:min-h-0 ${
        active
          ? "cursor-pointer border-foreground/40 bg-foreground/[0.06] text-foreground"
          : unavailable
            ? "cursor-not-allowed border-border/60 bg-background text-foreground/35"
            : "cursor-pointer border-border bg-background text-foreground/70 hover:border-foreground/30 hover:text-foreground"
      }`}
    >
      {active && <Check className="size-3 shrink-0 text-foreground/70" aria-hidden="true" />}
      <span className="min-w-0 truncate tabular-nums">{label}</span>
      {count !== null && (
        <span
          className={`shrink-0 tabular-nums text-[11px] ${
            active ? "text-foreground/55" : unavailable ? "text-foreground/30" : "text-foreground/45"
          }`}
        >
          {count}
        </span>
      )}
    </button>
  );
}

function DateRangeField({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: string | null;
  onChange: (next: string | null) => void;
  min?: string;
  max?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11.5px] text-foreground/55">{label}</span>
      <SkynetDatePicker
        value={value}
        onChange={onChange}
        min={min ?? null}
        max={max ?? null}
        ariaLabel={label}
      />
    </label>
  );
}
