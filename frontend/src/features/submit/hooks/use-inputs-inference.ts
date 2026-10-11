"use client";

import * as React from "react";
import { toast } from "react-toastify";

import { getDatasetRows, inferInputs } from "@/shared/lib/api";
import { msg } from "@/shared/lib/messages";
import { parseDatasetFile } from "@/shared/lib/parse-dataset";
import { getActiveLocale } from "@/shared/lib/runtime-locale";
import type { DatasetSummary } from "@/shared/lib/api";
import type { DataMode, InputsInferenceResponse } from "@/shared/types/unified-run";

import {
  casesToRows,
  defaultInputFields,
  heldOutCounts,
  parseTypedInput,
  rowsToCases,
  singleInputCase,
  type HeldOutCounts,
  type Row,
} from "../lib/inputs-mode";
import type { InputsSlice, WizardV2Context } from "../lib/wizard-v2";

const SAMPLE_ROWS = 5;

interface LoadedData {
  rows: Row[];
  columns: string[];
  label: string | null;
  /** What the user typed, for a single input; sent as the inference note. */
  note: string;
}

// The full rows live outside the wizard state, which only keeps the cases
// built from them; they are cached here so returning to the step can still
// re-pick the input and expected columns. The wizard is single-instance.
let rowsCache: { key: string; rows: Row[] } | null = null;

function cacheKey(inputs: Pick<InputsSlice, "datasetLabel" | "rowCount" | "columns">): string {
  return JSON.stringify([inputs.datasetLabel, inputs.rowCount, inputs.columns]);
}

export interface InputsInferenceState {
  /** Rows to rebuild cases from when the user re-picks columns. */
  rows: Row[];
  loading: boolean;
  inferring: boolean;
  inferError: boolean;
  /** The last inference, for its warnings and held-out suggestion. */
  inference: InputsInferenceResponse | null;
  heldOut: HeldOutCounts;
  libraryOpen: boolean;
  setLibraryOpen: (open: boolean) => void;
  handleFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  handlePickDataset: (dataset: DatasetSummary) => Promise<void>;
  applyTypedInput: (text: string) => void;
  reinfer: () => void;
  setMode: (mode: DataMode) => void;
  toggleInputField: (field: string) => void;
  setExpectedField: (field: string | null) => void;
  clear: () => void;
}

/**
 * Step 2's data flow: loads a table (upload, library or connector import) or
 * a typed input, asks the backend how it should be read (one input or
 * input/output pairs), and keeps the cases in the inputs slice in step with
 * the user's mode and column picks. Loading new data unconfirms the step;
 * re-picking columns does not.
 */
export function useInputsInference(ctx: WizardV2Context): InputsInferenceState {
  const { state, patchInputs } = ctx;
  const { task, inputs } = state;

  const [rows, setRows] = React.useState<Row[]>(() => {
    if (rowsCache && rowsCache.key === cacheKey(inputs)) return rowsCache.rows;
    return casesToRows(inputs.cases);
  });
  const [loading, setLoading] = React.useState(false);
  const [inferring, setInferring] = React.useState(false);
  const [inferError, setInferError] = React.useState(false);
  const [inference, setInference] = React.useState<InputsInferenceResponse | null>(null);
  const [libraryOpen, setLibraryOpen] = React.useState(false);
  const [note, setNote] = React.useState("");
  const abortRef = React.useRef<AbortController | null>(null);

  React.useEffect(() => () => abortRef.current?.abort(), []);

  const infer = React.useCallback(
    async (data: LoadedData) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setInferring(true);
      setInferError(false);
      try {
        const res = await inferInputs(
          {
            objective: task.objective,
            background: task.background,
            artifact_kind: task.artifactKind ?? "prompt",
            starting_version: task.startingVersion,
            columns: data.columns,
            sample_rows: data.rows.slice(0, SAMPLE_ROWS),
            row_count: data.rows.length,
            user_note: data.note,
            locale: getActiveLocale(),
          },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setInference(res);
        if (res.mode === "single") {
          const input = res.single_input ?? data.rows[0] ?? {};
          patchInputs({
            mode: "single",
            cases: [singleInputCase(input)],
            inputFields: Object.keys(input),
            expectedField: null,
            rationale: res.rationale,
          });
        } else {
          const expectedField =
            res.expected_field && data.columns.includes(res.expected_field)
              ? res.expected_field
              : null;
          const picked = res.input_fields.filter(
            (f: string) => data.columns.includes(f) && f !== expectedField,
          );
          const inputFields = picked.length ? picked : defaultInputFields(data.columns, expectedField);
          patchInputs({
            mode: "pairs",
            cases: rowsToCases(data.rows, inputFields, expectedField),
            inputFields,
            expectedField,
            split: res.suggested_split,
            rationale: res.rationale,
          });
        }
      } catch {
        if (controller.signal.aborted) return;
        setInferError(true);
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          setInferring(false);
        }
      }
    },
    [task.objective, task.background, task.artifactKind, task.startingVersion, patchInputs],
  );

  // A fresh source replaces the cases outright; inference then refines how
  // they are read. Until it answers, a table reads as pairs over every column
  // and a typed input as a single case, so the step is never empty.
  const load = React.useCallback(
    (data: LoadedData) => {
      const isTable = data.label !== null;
      const columns = data.columns;
      rowsCache = null;
      setRows(data.rows);
      setNote(data.note);
      setInference(null);
      const slice: Partial<InputsSlice> = {
        datasetLabel: data.label,
        stagedDatasetId: null,
        columns,
        sampleRows: data.rows.slice(0, SAMPLE_ROWS),
        rowCount: data.rows.length,
        confirmed: false,
        rationale: "",
      };
      if (isTable && data.rows.length > 1) {
        Object.assign(slice, {
          mode: "pairs",
          inputFields: columns,
          expectedField: null,
          cases: rowsToCases(data.rows, columns, null),
        });
      } else {
        Object.assign(slice, {
          mode: "single",
          inputFields: Object.keys(data.rows[0] ?? {}),
          expectedField: null,
          cases: data.rows[0] ? [singleInputCase(data.rows[0])] : [],
        });
      }
      patchInputs(slice);
      rowsCache = { key: cacheKey(slice as InputsSlice), rows: data.rows };
      void infer(data);
    },
    [patchInputs, infer],
  );

  const handleFileUpload = React.useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      setLoading(true);
      try {
        const parsed = await parseDatasetFile(file);
        load({
          rows: parsed.rows as Row[],
          columns: parsed.columns,
          label: file.name,
          note: "",
        });
      } catch {
        toast.error(msg("submit.dataset.file_error"));
      } finally {
        setLoading(false);
      }
    },
    [load],
  );

  const handlePickDataset = React.useCallback(
    async (dataset: DatasetSummary) => {
      setLibraryOpen(false);
      setLoading(true);
      try {
        const res = await getDatasetRows(dataset.id);
        const data = res.rows as Row[];
        load({
          rows: data,
          columns: res.columns.length > 0 ? res.columns : Object.keys(data[0] ?? {}),
          label: dataset.name,
          note: "",
        });
      } catch {
        toast.error(msg("submit.dataset.file_error"));
      } finally {
        setLoading(false);
      }
    },
    [load],
  );

  const applyTypedInput = React.useCallback(
    (text: string) => {
      if (!text.trim()) return;
      const input = parseTypedInput(text);
      load({ rows: [input], columns: Object.keys(input), label: null, note: text });
    },
    [load],
  );

  const reinfer = React.useCallback(() => {
    if (rows.length === 0) return;
    void infer({ rows, columns: inputs.columns, label: inputs.datasetLabel, note });
  }, [infer, rows, inputs.columns, inputs.datasetLabel, note]);

  const setMode = React.useCallback(
    (mode: DataMode) => {
      if (mode === inputs.mode) return;
      if (mode === "single") {
        const first = rows[0] ?? {};
        const fields = inputs.inputFields.length ? inputs.inputFields : Object.keys(first);
        const input = inference?.single_input ?? rowsToCases([first], fields, null)[0]!.input;
        patchInputs({
          mode,
          cases: [singleInputCase(input)],
          inputFields: Object.keys(input),
          expectedField: null,
        });
        return;
      }
      const columns = inputs.columns.length ? inputs.columns : Object.keys(rows[0] ?? {});
      const inputFields = inputs.inputFields.filter((f) => columns.includes(f));
      const fields = inputFields.length ? inputFields : columns;
      patchInputs({
        mode,
        inputFields: fields,
        cases: rowsToCases(rows, fields, inputs.expectedField),
      });
    },
    [inputs.mode, inputs.inputFields, inputs.columns, inputs.expectedField, rows, inference, patchInputs],
  );

  const toggleInputField = React.useCallback(
    (field: string) => {
      const on = inputs.inputFields.includes(field);
      const inputFields = on
        ? inputs.inputFields.filter((f) => f !== field)
        : inputs.columns.filter((c) => c === field || inputs.inputFields.includes(c));
      const expectedField = !on && field === inputs.expectedField ? null : inputs.expectedField;
      patchInputs({
        inputFields,
        expectedField,
        cases: rowsToCases(rows, inputFields, expectedField),
      });
    },
    [inputs.inputFields, inputs.columns, inputs.expectedField, rows, patchInputs],
  );

  const setExpectedField = React.useCallback(
    (field: string | null) => {
      const inputFields = inputs.inputFields.filter((f) => f !== field);
      patchInputs({
        expectedField: field,
        inputFields,
        cases: rowsToCases(rows, inputFields, field),
      });
    },
    [inputs.inputFields, rows, patchInputs],
  );

  const clear = React.useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    rowsCache = null;
    setRows([]);
    setNote("");
    setInference(null);
    setInferring(false);
    setInferError(false);
    patchInputs({
      mode: null,
      cases: [],
      stagedDatasetId: null,
      datasetLabel: null,
      columns: [],
      sampleRows: [],
      rowCount: 0,
      inputFields: [],
      expectedField: null,
      rationale: "",
      confirmed: false,
    });
  }, [patchInputs]);

  const heldOut = React.useMemo(
    () => heldOutCounts(inputs.cases.length, inputs.split, inputs.mode),
    [inputs.cases.length, inputs.split, inputs.mode],
  );

  return {
    rows,
    loading,
    inferring,
    inferError,
    inference,
    heldOut,
    libraryOpen,
    setLibraryOpen,
    handleFileUpload,
    handlePickDataset,
    applyTypedInput,
    reinfer,
    setMode,
    toggleInputField,
    setExpectedField,
    clear,
  };
}
