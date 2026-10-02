import type { ParsedDataset } from "@/shared/lib/parse-dataset";
import type { DraftRecipe, WizardDraftRecord } from "./draft-record";

/** Ids of the dataset rows a stored draft points at, one per workflow. */
export type DraftDatasetRefs = Partial<Record<DraftRecipe, string>>;

export interface DraftDatasetPlan {
  /** The record with both datasets lifted out, small enough to rewrite on every save. */
  record: WizardDraftRecord;
  refs: DraftDatasetRefs;
  put: Array<{ id: string; dataset: ParsedDataset }>;
  remove: string[];
}

const RECIPES: DraftRecipe[] = ["program", "anything"];

function datasetOf(record: WizardDraftRecord, recipe: DraftRecipe): ParsedDataset | null {
  if (recipe === "program") return record.program?.data.parsedDataset ?? null;
  return record.anything?.data.parsedCases ?? null;
}

function withDataset(
  record: WizardDraftRecord,
  recipe: DraftRecipe,
  dataset: ParsedDataset | null,
): WizardDraftRecord {
  if (recipe === "program") {
    return record.program
      ? {
          ...record,
          program: { ...record.program, data: { ...record.program.data, parsedDataset: dataset } },
        }
      : record;
  }
  return record.anything
    ? {
        ...record,
        anything: { ...record.anything, data: { ...record.anything.data, parsedCases: dataset } },
      }
    : record;
}

/**
 * Split a draft into its small record and the dataset rows it needs.
 *
 * A dataset row is written only when the stored record does not already
 * point at that dataset's id. Ids follow object identity, so pausing in an
 * editor rewrites a few kilobytes instead of cloning thousands of rows.
 */
export function planDatasetWrite(
  record: WizardDraftRecord,
  stored: DraftDatasetRefs,
  idFor: (dataset: ParsedDataset) => string,
): DraftDatasetPlan {
  let small = record;
  const refs: DraftDatasetRefs = {};
  const put: DraftDatasetPlan["put"] = [];
  for (const recipe of RECIPES) {
    const dataset = datasetOf(record, recipe);
    if (!dataset) continue;
    const id = idFor(dataset);
    refs[recipe] = id;
    small = withDataset(small, recipe, null);
    if (stored[recipe] !== id && !put.some((p) => p.id === id)) put.push({ id, dataset });
  }
  const kept = new Set(Object.values(refs));
  const remove = [...new Set(Object.values(stored))].filter((id) => id && !kept.has(id));
  return { record: small, refs, put, remove };
}

/** Put the referenced datasets back into a record read from storage. */
export function attachDatasets(
  record: WizardDraftRecord,
  refs: DraftDatasetRefs,
  datasets: ReadonlyMap<string, ParsedDataset>,
): WizardDraftRecord {
  let full = record;
  for (const recipe of RECIPES) {
    const id = refs[recipe];
    if (!id) continue;
    // A missing row reads as "no dataset" rather than failing the whole draft.
    full = withDataset(full, recipe, datasets.get(id) ?? null);
  }
  return full;
}

/** The dataset row ids a stored row points at, ignoring anything malformed. */
export function readDatasetRefs(raw: unknown): DraftDatasetRefs {
  if (!raw || typeof raw !== "object") return {};
  const refs: DraftDatasetRefs = {};
  for (const recipe of RECIPES) {
    const id = (raw as Record<string, unknown>)[recipe];
    if (typeof id === "string" && id) refs[recipe] = id;
  }
  return refs;
}
