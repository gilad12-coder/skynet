"use client";

import * as React from "react";
import { CaretDown, Check, MagnifyingGlass, X } from "@/shared/ui/icons";
import type { FacetDimension, FacetOption } from "@/shared/lib/api";
import { modelDisplayName } from "@/shared/lib/formatters";
import { msg, formatMsg } from "@/shared/lib/messages";
import { getActiveIntlLocale } from "@/shared/lib/runtime-locale";
import { cn } from "@/shared/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/primitives/popover";
import { SkynetDatePicker } from "@/shared/ui/skynet-date-picker";
import { pickerRows } from "../lib/facet-options";
import { engineDisplayName } from "../lib/format";

interface FilterBarProps {
  /** The picker whose values are being fetched; `null` when every picker is closed. */
  openDimension: FacetDimension | null;
  onOpenChange: (dimension: FacetDimension, open: boolean) => void;
  /** The open picker's value search; owned by the caller so it resets on close. */
  facetQuery: string;
  onFacetQueryChange: (next: string) => void;
  /** The open picker's values: the busiest ones for the current context, or the ones matching `facetQuery`. */
  options: FacetOption[];
  /** Distinct values the open picker's dimension holds in the current context. */
  total: number;
  loading: boolean;
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
  /** Wipes every structured filter (the free-text query stays). */
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

const SEARCHABLE: ReadonlyArray<{
  dimension: Exclude<FacetDimension, "types">;
  displayName: (value: string) => string;
  /** Model and optimizer ids are Latin identifiers; module names are free text. */
  dir: "ltr" | "auto";
}> = [
  { dimension: "modules", displayName: (v) => v, dir: "auto" },
  { dimension: "models", displayName: modelDisplayName, dir: "ltr" },
  { dimension: "optimizers", displayName: engineDisplayName, dir: "ltr" },
];

/**
 * One dropdown per filter dimension, inline under the search field, the way
 * issue trackers and deploy dashboards filter their lists. Each dropdown is a
 * searchable picker built for dimensions that can hold thousands of distinct
 * values (models, above all): until the user types it lists only the busiest
 * handful ("Top 8 of 1,240"), ranked by the number of runs each would leave
 * alongside the other active filters, and typing searches the whole dimension
 * server-side. The selection is pinned at the top of its picker so a choice
 * stays visible and removable however far it ranks, and the trigger carries
 * the choice ("Model · gpt-4o", or a count) so nothing needs a second row of
 * tokens. Every pick applies immediately.
 */
export function FilterBar({
  openDimension,
  onOpenChange,
  facetQuery,
  onFacetQueryChange,
  options,
  total,
  loading,
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
}: FilterBarProps) {
  const selectedBy: Record<FacetDimension, string[]> = {
    models: selectedModels,
    optimizers: selectedOptimizers,
    types: selectedTypes,
    modules: selectedModules,
  };
  const changeBy: Record<FacetDimension, (next: string[]) => void> = {
    models: onChangeModels,
    optimizers: onChangeOptimizers,
    types: onChangeTypes,
    modules: onChangeModules,
  };
  const dateCount = (dateFrom ? 1 : 0) + (dateTo ? 1 : 0);
  const totalActive =
    selectedModels.length +
    selectedOptimizers.length +
    selectedTypes.length +
    selectedModules.length +
    dateCount;
  // A picker's empty list means "ruled out by the other filters" only when
  // there are other filters; with none active, it means the scope has none.
  const othersActive = (own: number) => totalActive - own > 0;

  return (
    <div
      role="group"
      aria-label={msg("explore.filters.title")}
      className="flex flex-wrap items-center gap-2"
    >
      {SEARCHABLE.map(({ dimension, displayName, dir }) => (
        <FacetPicker
          key={dimension}
          dimension={dimension}
          displayName={displayName}
          dir={dir}
          open={openDimension === dimension}
          onOpenChange={(open) => onOpenChange(dimension, open)}
          query={facetQuery}
          onQueryChange={onFacetQueryChange}
          options={openDimension === dimension ? options : []}
          total={openDimension === dimension ? total : 0}
          loading={openDimension === dimension && loading}
          selected={selectedBy[dimension]}
          onChange={changeBy[dimension]}
          othersActive={othersActive(selectedBy[dimension].length)}
        />
      ))}
      <TypePicker
        open={openDimension === "types"}
        onOpenChange={(open) => onOpenChange("types", open)}
        options={openDimension === "types" ? options : []}
        selected={selectedTypes}
        onChange={onChangeTypes}
      />
      <DateRangePicker from={dateFrom} to={dateTo} onChange={onChangeDateRange} />
      {totalActive > 0 && (
        <button
          type="button"
          onClick={onClearAll}
          className={`inline-flex h-[38px] cursor-pointer items-center gap-1 rounded-lg px-2 text-[12.5px] text-foreground/55 transition-colors hover:text-foreground lg:h-8 ${FOCUS_RING}`}
        >
          <X className="size-3.5" aria-hidden="true" />
          {msg("explore.filters.clear")}
        </button>
      )}
    </div>
  );
}

/**
 * The dropdown button: the dimension's name, then the single chosen value
 * or a count of the chosen values, so the bar reads as a sentence of the
 * active filters without a separate token row.
 */
const FilterTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    label: string;
    summary: string | null;
    count: number;
    open: boolean;
  }
>(function FilterTrigger({ label, summary, count, open, className, ...props }, ref) {
  const active = count > 0;
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        "inline-flex h-[38px] max-w-full cursor-pointer items-center gap-1.5 rounded-lg border bg-background px-2.5 text-[12.5px] transition-colors lg:h-8",
        active
          ? "border-foreground/40 text-foreground"
          : "border-border text-foreground/70 hover:border-foreground/30 hover:text-foreground",
        open && "bg-accent",
        FOCUS_RING,
        className,
      )}
      {...props}
    >
      <span className="shrink-0">{label}</span>
      {summary !== null && (
        <>
          <span className="text-foreground/35" aria-hidden="true">
            ·
          </span>
          <span className="min-w-0 max-w-[10rem] truncate font-medium">{summary}</span>
        </>
      )}
      {summary === null && count > 1 && (
        <span className="inline-flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-full bg-foreground px-1.5 text-[10.5px] font-medium tabular-nums text-background">
          {count}
        </span>
      )}
      <CaretDown
        className={cn(
          "size-3 shrink-0 text-foreground/45 transition-transform",
          open && "rotate-180",
        )}
        aria-hidden="true"
      />
    </button>
  );
});

function triggerSummary(selected: string[], displayName: (value: string) => string): string | null {
  const [only] = selected;
  return only !== undefined && selected.length === 1 ? displayName(only) : null;
}

/**
 * A searchable multi-select over one dimension: a combobox input that drives
 * a listbox, with the arrow keys walking the rows, Enter toggling, and the
 * footer saying how much of the dimension is in view.
 */
function FacetPicker({
  dimension,
  displayName,
  dir,
  open,
  onOpenChange,
  query,
  onQueryChange,
  options,
  total,
  loading,
  selected,
  onChange,
  othersActive,
}: {
  dimension: Exclude<FacetDimension, "types">;
  displayName: (value: string) => string;
  dir: "ltr" | "auto";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  query: string;
  onQueryChange: (next: string) => void;
  options: FacetOption[];
  total: number;
  loading: boolean;
  selected: string[];
  onChange: (next: string[]) => void;
  othersActive: boolean;
}) {
  const label = msg(`explore.filters.trigger.${dimension}`);
  const section = msg(`explore.filters.section.${dimension}`);
  const rows = React.useMemo(() => pickerRows(options, selected), [options, selected]);
  const [highlight, setHighlight] = React.useState(0);
  const activeIndex = rows.length === 0 ? -1 : Math.min(highlight, rows.length - 1);
  const listRef = React.useRef<HTMLUListElement>(null);
  const listId = React.useId();
  const optionId = (index: number) => `${listId}-${index}`;
  const searching = query.trim().length > 0;
  const numberFormat = React.useMemo(() => new Intl.NumberFormat(getActiveIntlLocale()), []);

  const toggle = (value: string) => {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  };
  const moveHighlight = (next: number) => {
    setHighlight(next);
    listRef.current
      ?.querySelector(`[data-index="${next}"]`)
      ?.scrollIntoView({ block: "nearest" });
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (rows.length === 0) return;
    const last = rows.length - 1;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveHighlight(activeIndex >= last ? 0 : activeIndex + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveHighlight(activeIndex <= 0 ? last : activeIndex - 1);
        break;
      case "Home":
        event.preventDefault();
        moveHighlight(0);
        break;
      case "End":
        event.preventDefault();
        moveHighlight(last);
        break;
      case "Enter":
        event.preventDefault();
        if (rows[activeIndex]) toggle(rows[activeIndex].value);
        break;
    }
  };

  // Beyond the ranked slice there is more to find by typing; say so only
  // when it is true, since "Top 8 of 8" would just be noise.
  const meta =
    total > options.length
      ? formatMsg(searching ? "explore.filters.group.matches" : "explore.filters.group.top", {
          shown: numberFormat.format(options.length),
          total: numberFormat.format(total),
        })
      : null;
  const emptyMessage = searching
    ? msg("explore.filters.section.no_search_match")
    : othersActive
      ? msg("explore.filters.section.none_in_selection")
      : msg("explore.filters.empty_section");

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <FilterTrigger
          label={label}
          summary={triggerSummary(selected, displayName)}
          count={selected.length}
          open={open}
        />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={16}
        className="w-[min(22rem,calc(100vw-2rem))] overflow-hidden p-0"
      >
        <div className="flex h-10 items-center gap-2 border-b border-border/60 px-3">
          <MagnifyingGlass className="size-3.5 shrink-0 text-foreground/45" aria-hidden="true" />
          <input
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
            aria-autocomplete="list"
            aria-label={formatMsg("explore.filters.section.search", { section })}
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => {
              onQueryChange(event.target.value);
              setHighlight(0);
            }}
            onKeyDown={onKeyDown}
            placeholder={msg(`explore.filters.picker.placeholder.${dimension}`)}
            className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-foreground/40"
          />
          {searching && (
            <button
              type="button"
              onClick={() => {
                onQueryChange("");
                setHighlight(0);
              }}
              aria-label={msg("explore.filters.search.clear")}
              className={`inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-foreground/45 hover:bg-accent hover:text-foreground ${FOCUS_RING}`}
            >
              <X className="size-3" aria-hidden="true" />
            </button>
          )}
        </div>

        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-multiselectable="true"
          aria-label={section}
          aria-busy={loading}
          className="max-h-[min(50vh,20rem)] overflow-y-auto py-1"
        >
          {rows.map((row, index) => (
            <li
              key={row.value}
              id={optionId(index)}
              role="option"
              aria-selected={row.checked}
              data-index={index}
              onMouseMove={() => setHighlight(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => toggle(row.value)}
              className={cn(
                "flex h-11 cursor-pointer select-none items-center gap-2.5 px-3 text-[13px] lg:h-9",
                index === activeIndex && "bg-accent",
              )}
            >
              <span
                className={cn(
                  "flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
                  row.checked ? "border-foreground bg-foreground text-background" : "border-border",
                )}
                aria-hidden="true"
              >
                {row.checked && <Check className="size-3" />}
              </span>
              <span dir={dir} className="min-w-0 flex-1 truncate text-foreground">
                {displayName(row.value)}
              </span>
              {row.count !== null && (
                <span className="shrink-0 text-[12px] tabular-nums text-foreground/45">
                  {numberFormat.format(row.count)}
                </span>
              )}
            </li>
          ))}
          {rows.length === 0 &&
            (loading ? (
              Array.from({ length: 5 }, (_, index) => (
                <li key={index} className="flex h-11 items-center gap-2.5 px-3 lg:h-9" aria-hidden="true">
                  <span className="size-4 rounded-[4px] border border-border/60" />
                  <span
                    className="h-2.5 animate-pulse rounded bg-foreground/8"
                    style={{ width: `${45 + ((index * 17) % 35)}%` }}
                  />
                </li>
              ))
            ) : (
              <li className="px-3 py-4 text-center text-[12.5px] text-foreground/50">{emptyMessage}</li>
            ))}
        </ul>

        {(meta !== null || selected.length > 0) && (
          <div className="flex h-9 items-center justify-between gap-3 border-t border-border/60 px-3 text-[11.5px] text-foreground/50">
            <span className="tabular-nums">{meta}</span>
            {selected.length > 0 && (
              <button
                type="button"
                onClick={() => onChange([])}
                className={`cursor-pointer rounded-md px-1 text-foreground/65 hover:text-foreground ${FOCUS_RING}`}
              >
                {msg("explore.filters.picker.clear")}
              </button>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Run types are a fixed trio, so their picker skips the search box and lists
 * all three in a stable order with the fetched counts attached. Until a fetch
 * has answered the counts are unknown rather than zero, and a type with no
 * runs in the current context is disabled instead of hidden.
 */
function TypePicker({
  open,
  onOpenChange,
  options,
  selected,
  onChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  options: FacetOption[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const numberFormat = React.useMemo(() => new Intl.NumberFormat(getActiveIntlLocale()), []);
  const toggle = (value: string) => {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  };
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <FilterTrigger
          label={msg("explore.filters.trigger.types")}
          summary={triggerSummary(selected, typeLabel)}
          count={selected.length}
          open={open}
        />
      </PopoverTrigger>
      <PopoverContent align="start" collisionPadding={16} className="w-56 overflow-hidden p-0">
        <div role="group" aria-label={msg("explore.filters.section.types")} className="py-1">
          {TYPE_VALUES.map((type) => {
            const checked = selected.includes(type.value);
            const count =
              options.length === 0
                ? null
                : (options.find((o) => o.value === type.value)?.count ?? 0);
            const disabled = count === 0 && !checked;
            return (
              <button
                key={type.value}
                type="button"
                role="checkbox"
                aria-checked={checked}
                disabled={disabled}
                onClick={() => toggle(type.value)}
                className={cn(
                  "flex h-11 w-full cursor-pointer items-center gap-2.5 px-3 text-[13px] text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent lg:h-9",
                  FOCUS_RING,
                )}
              >
                <span
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
                    checked ? "border-foreground bg-foreground text-background" : "border-border",
                  )}
                  aria-hidden="true"
                >
                  {checked && <Check className="size-3" />}
                </span>
                <span className="min-w-0 flex-1 truncate text-start">{msg(type.labelKey)}</span>
                {count !== null && (
                  <span className="shrink-0 text-[12px] tabular-nums text-foreground/45">
                    {numberFormat.format(count)}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {selected.length > 0 && (
          <div className="flex h-9 items-center justify-end border-t border-border/60 px-3 text-[11.5px]">
            <button
              type="button"
              onClick={() => onChange([])}
              className={`cursor-pointer rounded-md px-1 text-foreground/65 hover:text-foreground ${FOCUS_RING}`}
            >
              {msg("explore.filters.picker.clear")}
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** A "from" and "to" calendar in one dropdown; the trigger reads the range back. */
function DateRangePicker({
  from,
  to,
  onChange,
}: {
  from: string | null;
  to: string | null;
  onChange: (from: string | null, to: string | null) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const formatDay = React.useMemo(() => {
    const formatter = new Intl.DateTimeFormat(getActiveIntlLocale(), {
      dateStyle: "medium",
      timeZone: "UTC",
    });
    return (iso: string) => formatter.format(new Date(`${iso}T00:00:00Z`));
  }, []);
  const count = (from ? 1 : 0) + (to ? 1 : 0);
  const summary =
    from && to
      ? formatMsg("explore.filters.date.range", { from: formatDay(from), to: formatDay(to) })
      : from
        ? `${msg("explore.filters.date.from")} ${formatDay(from)}`
        : to
          ? `${msg("explore.filters.date.to")} ${formatDay(to)}`
          : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <FilterTrigger
          label={msg("explore.filters.trigger.date")}
          summary={summary}
          count={count}
          open={open}
        />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={16}
        className="w-[min(18rem,calc(100vw-2rem))] p-3"
      >
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-[11.5px] font-medium uppercase tracking-[0.08em] text-foreground/50">
              {msg("explore.filters.date.from")}
            </span>
            <SkynetDatePicker
              value={from}
              onChange={(next) => onChange(next, to)}
              max={to}
              ariaLabel={msg("explore.filters.date.from")}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[11.5px] font-medium uppercase tracking-[0.08em] text-foreground/50">
              {msg("explore.filters.date.to")}
            </span>
            <SkynetDatePicker
              value={to}
              onChange={(next) => onChange(from, next)}
              min={from}
              ariaLabel={msg("explore.filters.date.to")}
            />
          </label>
          {count > 0 && (
            <button
              type="button"
              onClick={() => onChange(null, null)}
              className={`self-end cursor-pointer rounded-md px-1 text-[11.5px] text-foreground/65 hover:text-foreground ${FOCUS_RING}`}
            >
              {msg("explore.filters.picker.clear")}
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
