"use client";

import { useEffect, useState } from "react";
import { getCorpusFacets, type CorpusFacets, type FacetContext } from "@/shared/lib/api";
import type { ExploreCorpus } from "./use-semantic-search";

const EMPTY: CorpusFacets = { models: [], optimizers: [], modules: [], types: [] };

export interface FacetFilters {
  models: string[];
  optimizers: string[];
  types: string[];
  modules: string[];
  dateFrom: string | null;
  dateTo: string | null;
}

/**
 * Filter options for the active corpus tab, each with the number of runs it
 * would leave alongside the other active filters, so each tab offers exactly
 * the chips it can filter to — a model private to "mine" never shows under
 * "public" — and can grey out the ones the current selection rules out.
 * Refetches when the corpus, signed-in user, or any structured filter
 * changes (the free-text query is not part of the counts); the previous
 * facets stay on screen while the new ones load so chips never flicker away.
 * Signed-out "mine"/"shared" have nothing to fetch and resolve to empty.
 * The backend returns every dimension sorted by value.
 */
export function useCorpusFacets(
  corpus: ExploreCorpus,
  sessionUser: string,
  filters: FacetFilters,
): CorpusFacets {
  const [facets, setFacets] = useState<CorpusFacets>(EMPTY);
  // One primitive dependency for the arrays and dates together: the URL-state
  // hook hands back fresh arrays on unrelated updates, and a serialized key
  // only changes when a filter value actually does.
  const filterKey = JSON.stringify([
    filters.models,
    filters.optimizers,
    filters.types,
    filters.modules,
    filters.dateFrom,
    filters.dateTo,
  ]);

  useEffect(() => {
    let cancelled = false;

    if (corpus !== "public" && !sessionUser) {
      setFacets(EMPTY);
      return;
    }

    const scope =
      corpus === "mine"
        ? { owner_username: sessionUser }
        : corpus === "shared"
          ? { shared_with_username: sessionUser }
          : {};
    const [models, optimizers, types, modules, dateFrom, dateTo] = JSON.parse(filterKey) as [
      string[],
      string[],
      string[],
      string[],
      string | null,
      string | null,
    ];
    const context: FacetContext = {
      models,
      optimizers,
      optimization_types: types,
      modules,
      date_from: dateFrom ?? undefined,
      date_to: dateTo ?? undefined,
    };

    void (async () => {
      try {
        const data = await getCorpusFacets(scope, context);
        if (!cancelled) setFacets(data);
      } catch {
        if (!cancelled) setFacets(EMPTY);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [corpus, sessionUser, filterKey]);

  return facets;
}
