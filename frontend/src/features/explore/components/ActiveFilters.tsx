"use client";

import { X } from "@/shared/ui/icons";
import { formatDate, modelDisplayName } from "@/shared/lib/formatters";
import { msg, formatMsg } from "@/shared/lib/messages";
import { engineDisplayName } from "../lib/format";
import { typeLabel } from "./FiltersDrawer";

interface ActiveFiltersProps {
  models: string[];
  optimizers: string[];
  types: string[];
  modules: string[];
  dateFrom: string | null;
  dateTo: string | null;
  onChangeModels: (next: string[]) => void;
  onChangeOptimizers: (next: string[]) => void;
  onChangeTypes: (next: string[]) => void;
  onChangeModules: (next: string[]) => void;
  onChangeDateRange: (from: string | null, to: string | null) => void;
  onClearAll: () => void;
}

interface Token {
  key: string;
  /** Which dimension the value belongs to, so "predict" and "run" read unambiguously. */
  group: string;
  label: string;
  dir: "ltr" | "auto";
  onRemove: () => void;
}

/**
 * The structured filters currently applied, as removable tokens under the
 * search bar. The drawer is where filters are chosen; this row is where
 * their state lives in the page, so nobody has to reopen the drawer to see
 * why the results are narrow or to drop one filter. Renders nothing when
 * no filter is active.
 */
export function ActiveFilters({
  models,
  optimizers,
  types,
  modules,
  dateFrom,
  dateTo,
  onChangeModels,
  onChangeOptimizers,
  onChangeTypes,
  onChangeModules,
  onChangeDateRange,
  onClearAll,
}: ActiveFiltersProps) {
  const without = (list: string[], value: string) => list.filter((v) => v !== value);
  const tokens: Token[] = [
    ...modules.map((v) => ({
      key: `module:${v}`,
      group: msg("explore.filters.section.modules"),
      label: v,
      dir: "auto" as const,
      onRemove: () => onChangeModules(without(modules, v)),
    })),
    ...models.map((v) => ({
      key: `model:${v}`,
      group: msg("explore.filters.section.models"),
      label: modelDisplayName(v),
      dir: "ltr" as const,
      onRemove: () => onChangeModels(without(models, v)),
    })),
    ...optimizers.map((v) => ({
      key: `optimizer:${v}`,
      group: msg("explore.filters.section.optimizers"),
      label: engineDisplayName(v),
      dir: "ltr" as const,
      onRemove: () => onChangeOptimizers(without(optimizers, v)),
    })),
    ...types.map((v) => ({
      key: `type:${v}`,
      group: msg("explore.filters.section.types"),
      label: typeLabel(v),
      dir: "auto" as const,
      onRemove: () => onChangeTypes(without(types, v)),
    })),
  ];
  if (dateFrom || dateTo) {
    const from = dateFrom ? formatDate(dateFrom) : null;
    const to = dateTo ? formatDate(dateTo) : null;
    tokens.push({
      key: "date",
      group: msg("explore.filters.section.date"),
      label:
        from && to
          ? `${from} – ${to}`
          : from
            ? `${msg("explore.filters.date.from")} ${from}`
            : `${msg("explore.filters.date.to")} ${to}`,
      dir: "auto",
      onRemove: () => onChangeDateRange(null, null),
    });
  }
  if (tokens.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tokens.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={t.onRemove}
          aria-label={formatMsg("explore.filters.active.remove", { label: t.label })}
          title={formatMsg("explore.filters.active.remove", { label: t.label })}
          className="group inline-flex h-7 max-w-full cursor-pointer items-center gap-1.5 rounded-md border border-border bg-background ps-2 pe-1.5 text-[12px] text-foreground/80 transition-[border-color,background-color,color] hover:border-foreground/30 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C8A882]/45"
        >
          <span className="shrink-0 text-foreground/45">{t.group}</span>
          <span dir={t.dir} className="min-w-0 truncate">
            {t.label}
          </span>
          <X
            className="size-3 shrink-0 text-foreground/40 transition-colors group-hover:text-foreground"
            aria-hidden="true"
          />
        </button>
      ))}
      {tokens.length > 1 && (
        <button
          type="button"
          onClick={onClearAll}
          className="inline-flex h-7 cursor-pointer items-center rounded-md px-2 text-[12px] text-foreground/55 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C8A882]/45"
        >
          {msg("explore.filters.clear")}
        </button>
      )}
    </div>
  );
}
