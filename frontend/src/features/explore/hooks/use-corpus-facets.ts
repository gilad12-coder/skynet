"use client";

import { useEffect, useState } from "react";
import { getCorpusFacets, type CorpusFacets, type FacetContext } from "@/shared/lib/api";
import { FACET_LIMIT } from "../lib/facet-options";
import type { ExploreCorpus } from "./use-semantic-search";

export const EMPTY_FACETS: CorpusFacets = {
  models: [],
  optimizers: [],
  modules: [],
  types: [],
  totals: { models: 0, optimizers: 0, modules: 0, types: 0 },
};

/** Keystrokes settle for this long before a value search hits the backend. */
const SEARCH_DEBOUNCE_MS = 180;

export interface FacetFilters {
  models: string[];
  optimizers: string[];
  types: string[];
  modules: string[];
  dateFrom: string | null;
  dateTo: string | null;
}

/**
 * The busiest filter values for the active corpus tab, each with the number
 * of runs it would leave alongside the other active filters, so each tab
 * offers exactly the values it can filter to — a model private to "mine"
 * never shows under "public". Nothing is fetched in full: the backend caps
 * every dimension and reports the total, and `query` turns the same request
 * into a server-side value search (debounced) across all dimensions.
 * Refetches when the corpus, signed-in user, query, or any structured filter
 * changes (the free-text run query is not part of the counts); the previous
 * facets stay on screen while the new ones load so rows never flicker away.
 * Signed-out "mine"/"shared" have nothing to fetch and resolve to empty.
 */
export function useCorpusFacets(
  corpus: ExploreCorpus,
  sessionUser: string,
  filters: FacetFilters,
  query = "",
): { facets: CorpusFacets; loading: boolean } {
  const [facets, setFacets] = useState<CorpusFacets>(EMPTY_FACETS);
  const [loading, setLoading] = useState(false);
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
  const trimmedQuery = query.trim();

  useEffect(() => {
    let cancelled = false;

    if (corpus !== "public" && !sessionUser) {
      setFacets(EMPTY_FACETS);
      setLoading(false);
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

    setLoading(true);
    // Only typing is debounced; filter changes and the initial load go out
    // immediately so counts follow a tick without lag.
    const timer = setTimeout(
      () => {
        void (async () => {
          try {
            const data = await getCorpusFacets(scope, context, {
              query: trimmedQuery,
              limit: FACET_LIMIT,
            });
            if (!cancelled) setFacets(data);
          } catch {
            if (!cancelled) setFacets(EMPTY_FACETS);
          } finally {
            if (!cancelled) setLoading(false);
          }
        })();
      },
      trimmedQuery ? SEARCH_DEBOUNCE_MS : 0,
    );

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [corpus, sessionUser, filterKey, trimmedQuery]);

  return { facets, loading };
}
