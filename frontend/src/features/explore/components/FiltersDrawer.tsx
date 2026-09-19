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
import type { CorpusFacets, FacetOption } from "@/shared/lib/api";
import { modelDisplayName } from "@/shared/lib/formatters";
import { msg, formatMsg } from "@/shared/lib/messages";
import { getActiveDir, getActiveIntlLocale } from "@/shared/lib/runtime-locale";
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
import { ActiveFilters } from "./ActiveFilters";

interface FiltersDrawerProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  /**
   * The busiest values per dimension for the current context (or, while
   * `facetQuery` is non-empty, the values matching it), each with the number
   * of runs it would leave alongside the other active filters, plus the
   * number of distinct values available per dimension.
   */
  facets: CorpusFacets;
  facetsLoading: boolean;
  /** Live value search across every dimension; owned by the caller so it can reset on close. */
  facetQuery: string;
  onFacetQueryChange: (next: string) => void;
  /** Currently active filter values. */
  selectedModels: string[];
  selectedOptimizers: string[];
  selectedTypes: string[];
  selectedModules: string[];
  dateFrom: string | null;
  dateTo: string | null;
  /** Live result count for the current query + filters, shown on the primary button. */
  resultTotal: number;
  resultsLoading: boolean;
  onChangeModels: (next: string[]) => void;
  onChangeOptimizers: (next: string[]) => void;
  onChangeTypes: (next: string[]) => void;
  onChangeModules: (next: string[]) => void;
  onChangeDateRange: (from: string | null, to: string | null) => void;
  /** Wipes every filter inside the drawer (excluding free-text query). */
  onClearAll: () => void;
}

export const TYPE_VALUES: ReadonlyArray<{
  value: string;
  labelKey: Parameters<typeof msg>[0];
}> = [
  { value: "run", labelKey: "explore.filter.run" },
  { value: "grid_search", labelKey: "explore.filter.grid" },
  { value: "blackbox", labelKey: "explore.filter.blackbox" },
];

/** Display label for a run-type value; unknown values fall back to the raw id. */
export function typeLabel(value: string): string {
  const entry = TYPE_VALUES.find((t) => t.value === value);
  return entry ? msg(entry.labelKey) : value;
}

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C8A882]/45";

/**
 * Slide-in panel for structured filtering on top of the free-text query,
 * built for corpora where a single dimension (models, above all) can hold
 * thousands of distinct values. Nothing is ever listed in full: one search
 * box at the top queries every dimension server-side, and until the user
 * types, each dimension shows only its busiest handful of values ("top 8 of
 * 1,240"), ranked by the number of runs each would leave alongside the other
 * active filters. Values the current selection rules out are not shown at
 * all. The applied filters sit in their own section as removable tokens, so
 * selection state never depends on a value being in view. Filters apply
 * immediately; the primary button reports the live result count so the
 * effect of each choice is visible before the drawer closes.
 */
export function FiltersDrawer({
  open,
  onOpenChange,
  facets,
  facetsLoading,
  facetQuery,
  onFacetQueryChange,
  selectedModels,
  selectedOptimizers,
  selectedTypes,
  selectedModules,
  dateFrom,
  dateTo,
  resultTotal,
  resultsLoading,
  onChangeModels,
  onChangeOptimizers,
  onChangeTypes,
  onChangeModules,
  onChangeDateRange,
  onClearAll,
}: FiltersDrawerProps) {
  const dateCount = (dateFrom ? 1 : 0) + (dateTo ? 1 : 0);
  const totalActive =
    selectedModels.length +
    selectedOptimizers.length +
    selectedTypes.length +
    selectedModules.length +
    dateCount;
  const isRtl = getActiveDir() === "rtl";
  const searching = facetQuery.trim().length > 0;
  // A dimension's empty list means "ruled out by the other filters" only when
  // there are other filters; with none active, it means the scope has none.
  const othersActive = (own: number) => totalActive - own > 0;
  // Run types render in a fixed order with the fetched count attached; an
  // empty fetch (loading, error) leaves counts unknown rather than zero.
  const typeRows = React.useMemo<FacetOption[]>(() => {
    if (facets.types.length === 0) return TYPE_VALUES.map((t) => ({ value: t.value, count: -1 }));
    return TYPE_VALUES.map((t) => ({
      value: t.value,
      count: facets.types.find((o) => o.value === t.value)?.count ?? 0,
    }));
  }, [facets.types]);
  // Phones get a bottom sheet capped below the top edge; desktop keeps the
  // side drawer on the reading-end edge. Focus lands in the search box on
  // desktop; on phones that would raise the keyboard over the list.
  const isPhone = useIsPhone();
  const searchRef = React.useRef<HTMLInputElement>(null);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={isPhone ? "bottom" : isRtl ? "left" : "right"}
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          if (!isPhone) searchRef.current?.focus();
        }}
        className={
          isPhone
            ? "max-h-[85dvh] w-full gap-0 rounded-t-2xl border-border bg-background p-0 pb-[env(safe-area-inset-bottom)]"
            : "w-full !max-w-md gap-0 border-border bg-background p-0"
        }
      >
        <div className="flex h-full min-h-0 flex-col">
          <SheetHeader className="flex-row items-start justify-between gap-3 px-6 pt-5 pb-4">
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
              className={`inline-flex size-[44px] shrink-0 cursor-pointer items-center justify-center rounded-lg text-foreground/55 transition-[background-color,color] hover:bg-accent hover:text-foreground lg:size-9 ${FOCUS_RING}`}
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </SheetHeader>

          <div className="border-b border-border/60 px-6 pb-4">
            <ValueSearchInput
              ref={searchRef}
              value={facetQuery}
              onChange={onFacetQueryChange}
              busy={facetsLoading && searching}
            />
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-5" aria-busy={facetsLoading}>
            <div className="flex flex-col gap-8">
              {totalActive > 0 && (
                <section className="flex flex-col gap-2.5">
                  <GroupHeader title={msg("explore.filters.active")} meta={String(totalActive)} />
                  <ActiveFilters
                    models={selectedModels}
                    optimizers={selectedOptimizers}
                    types={selectedTypes}
                    modules={selectedModules}
                    dateFrom={dateFrom}
                    dateTo={dateTo}
                    onChangeModels={onChangeModels}
                    onChangeOptimizers={onChangeOptimizers}
                    onChangeTypes={onChangeTypes}
                    onChangeModules={onChangeModules}
                    onChangeDateRange={onChangeDateRange}
                    onClearAll={onClearAll}
                  />
                </section>
              )}

              {/* The optimization itself first (program, model, optimizer);
                  the run's own metadata (kind, date) only when browsing —
                  a value search is about the three open-ended dimensions. */}
              <ValueGroup
                title={msg("explore.filters.section.modules")}
                icon={Cube}
                options={facets.modules}
                total={facets.totals.modules}
                selected={selectedModules}
                searching={searching}
                othersActive={othersActive(selectedModules.length)}
                onToggle={(v) => onChangeModules(toggleValue(selectedModules, v))}
                dir="auto"
              />
              <ValueGroup
                title={msg("explore.filters.section.models")}
                icon={Cpu}
                options={facets.models}
                total={facets.totals.models}
                selected={selectedModels}
                searching={searching}
                othersActive={othersActive(selectedModels.length)}
                onToggle={(v) => onChangeModels(toggleValue(selectedModels, v))}
                labelOf={modelDisplayName}
                dir="ltr"
              />
              <ValueGroup
                title={msg("explore.filters.section.optimizers")}
                icon={Target}
                options={facets.optimizers}
                total={facets.totals.optimizers}
                selected={selectedOptimizers}
                searching={searching}
                othersActive={othersActive(selectedOptimizers.length)}
                onToggle={(v) => onChangeOptimizers(toggleValue(selectedOptimizers, v))}
                labelOf={engineDisplayName}
                dir="ltr"
              />

              {!searching && (
                <>
                  <section className="flex flex-col gap-1.5">
                    <GroupHeader title={msg("explore.filters.section.types")} icon={Stack} />
                    <div role="group" aria-label={msg("explore.filters.section.types")} className="-mx-2 flex flex-col">
                      {typeRows.map(({ value, count }) => {
                        const checked = selectedTypes.includes(value);
                        return (
                          <ValueRow
                            key={value}
                            label={typeLabel(value)}
                            count={count < 0 ? null : count}
                            checked={checked}
                            // A checked row always stays clickable so it can be
                            // unchecked; only a type the other filters rule out
                            // is taken off the table.
                            disabled={!checked && count === 0}
                            dir="auto"
                            onToggle={() => onChangeTypes(toggleValue(selectedTypes, value))}
                          />
                        );
                      })}
                    </div>
                  </section>

                  <section className="flex flex-col gap-2.5">
                    <GroupHeader title={msg("explore.filters.section.date")} icon={CalendarBlank} />
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
                  </section>
                </>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-border/60 bg-background px-6 py-4">
            <button
              type="button"
              onClick={onClearAll}
              disabled={totalActive === 0}
              className={`inline-flex items-center justify-center rounded-lg px-3 py-2 text-[13px] text-foreground/65 transition-[background-color,color] cursor-pointer hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:text-foreground/30 disabled:hover:bg-transparent ${FOCUS_RING}`}
            >
              {msg("explore.filters.clear")}
            </button>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              aria-busy={resultsLoading}
              className={`inline-flex items-center justify-center rounded-lg bg-foreground px-4 py-2 text-[13px] font-medium tabular-nums text-background transition-[background-color,opacity] cursor-pointer hover:bg-foreground/90 ${FOCUS_RING} ${
                resultsLoading ? "opacity-70" : ""
              }`}
            >
              {resultTotal === 1
                ? msg("explore.filters.show_results_one")
                : formatMsg("explore.filters.show_results", { n: resultTotal })}
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

function formatCount(n: number): string {
  return new Intl.NumberFormat(getActiveIntlLocale()).format(n);
}

type IconComponent = React.ComponentType<{
  className?: string;
  "aria-hidden"?: boolean | "true";
}>;

function GroupHeader({
  title,
  icon: Icon,
  meta,
}: {
  title: string;
  icon?: IconComponent;
  /** Right-aligned figure, e.g. "Top 8 of 1,240". */
  meta?: string;
}) {
  return (
    <div className="flex min-h-6 items-center justify-between gap-3">
      <h3 className="inline-flex items-center gap-2 text-[12px] font-medium tracking-wide text-foreground/60">
        {Icon && <Icon className="size-3.5 text-foreground/45" aria-hidden="true" />}
        <span>{title}</span>
      </h3>
      {meta && <span className="shrink-0 text-[12px] tabular-nums text-foreground/45">{meta}</span>}
    </div>
  );
}

function ValueGroup({
  title,
  icon,
  options,
  total,
  selected,
  searching,
  othersActive,
  onToggle,
  labelOf = (v) => v,
  dir,
}: {
  title: string;
  icon?: IconComponent;
  /** The busiest (or matching) values, already ranked and capped by the source. */
  options: FacetOption[];
  /** Distinct values available in this dimension, beyond the ones listed. */
  total: number;
  selected: string[];
  searching: boolean;
  /** Whether any filter outside this dimension is active (an empty list then means "ruled out"). */
  othersActive: boolean;
  onToggle: (value: string) => void;
  labelOf?: (value: string) => string;
  /**
   * Per-row text direction. LTR for code identifiers, auto for user-authored
   * names that may be either (modules).
   */
  dir: "ltr" | "rtl" | "auto";
}) {
  const shown = options.length;
  const truncated = total > shown;
  const meta = truncated
    ? formatMsg(searching ? "explore.filters.group.matches" : "explore.filters.group.top", {
        shown: formatCount(shown),
        total: formatCount(total),
      })
    : undefined;
  const emptyText = searching
    ? msg("explore.filters.section.no_search_match")
    : othersActive
      ? msg("explore.filters.section.none_in_selection")
      : msg("explore.filters.empty_section");

  return (
    <section className="flex flex-col gap-1.5">
      <GroupHeader title={title} icon={icon} meta={meta} />
      {shown === 0 ? (
        <p className="py-1 text-[12.5px] text-foreground/45">{emptyText}</p>
      ) : (
        <div role="group" aria-label={title} className="-mx-2 flex flex-col">
          {options.map(({ value, count }) => {
            const label = labelOf(value);
            return (
              <ValueRow
                key={value}
                label={label}
                // Trimmed labels (e.g. bare model names) keep the full value
                // reachable on hover — providers can collide on the short name.
                title={label === value ? undefined : value}
                count={count}
                checked={selected.includes(value)}
                dir={dir}
                onToggle={() => onToggle(value)}
              />
            );
          })}
        </div>
      )}
      {truncated && !searching && (
        <p className="text-[12px] text-foreground/45">
          {formatMsg("explore.filters.group.rest", { n: formatCount(total - shown) })}
        </p>
      )}
    </section>
  );
}

function ValueRow({
  label,
  title,
  count,
  checked,
  disabled = false,
  dir,
  onToggle,
}: {
  label: string;
  title?: string;
  /** Null when the count is unknown (facets not loaded). */
  count: number | null;
  checked: boolean;
  disabled?: boolean;
  dir: "ltr" | "rtl" | "auto";
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      title={title}
      onClick={onToggle}
      className={`group flex min-h-[44px] w-full items-center gap-3 rounded-md px-2 py-1.5 text-start transition-[background-color,color] focus-visible:ring-inset lg:min-h-9 ${FOCUS_RING} ${
        disabled
          ? "cursor-not-allowed text-foreground/35"
          : checked
            ? "cursor-pointer text-foreground hover:bg-accent"
            : "cursor-pointer text-foreground/80 hover:bg-accent hover:text-foreground"
      }`}
    >
      {/* A fixed slot keeps labels aligned whether or not the mark shows. */}
      <span
        aria-hidden="true"
        className={`flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-[background-color,border-color] ${
          checked
            ? "border-foreground bg-foreground text-background"
            : disabled
              ? "border-foreground/15"
              : "border-foreground/25 group-hover:border-foreground/50"
        }`}
      >
        {checked && <Check className="size-3" aria-hidden="true" />}
      </span>
      <span dir={dir} className="min-w-0 flex-1 truncate text-[13px]">
        {label}
      </span>
      {count !== null && (
        <span
          className={`shrink-0 text-[12px] tabular-nums ${
            disabled ? "text-foreground/30" : "text-foreground/45"
          }`}
        >
          {formatCount(count)}
        </span>
      )}
    </button>
  );
}

const ValueSearchInput = React.forwardRef<
  HTMLInputElement,
  { value: string; onChange: (next: string) => void; busy: boolean }
>(function ValueSearchInput({ value, onChange, busy }, ref) {
  return (
    <div className="relative">
      <MagnifyingGlass
        className={`pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 transition-opacity ${
          busy ? "animate-pulse text-foreground/60" : "text-foreground/40"
        }`}
        aria-hidden="true"
      />
      <input
        ref={ref}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Escape clears the search before it is allowed to close the sheet.
          if (e.key === "Escape" && value) {
            e.stopPropagation();
            onChange("");
          }
        }}
        placeholder={msg("explore.filters.search.placeholder")}
        aria-label={msg("explore.filters.search.placeholder")}
        autoComplete="off"
        spellCheck={false}
        dir="auto"
        className={`h-10 w-full rounded-lg border border-border bg-background ps-10 pe-10 text-[13.5px] text-foreground placeholder:text-foreground/40 transition-colors hover:border-foreground/30 focus:border-foreground/40 focus:outline-none [&::-webkit-search-cancel-button]:hidden ${FOCUS_RING}`}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label={msg("explore.filters.search.clear")}
          className={`absolute end-1.5 top-1/2 inline-flex size-7 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-foreground/50 transition-[background-color,color] hover:bg-accent hover:text-foreground ${FOCUS_RING}`}
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
});

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
