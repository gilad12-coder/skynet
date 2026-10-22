"use client";

import * as React from "react";

import { Warning } from "@/shared/ui/icons";
import { ColumnRoleRow } from "@/shared/ui/column-role-row";
import { PingDot } from "@/shared/ui/ping-dot";
import { RetryIconButton } from "@/shared/ui/retry-icon-button";
import type { SplitFractions, SplitPlan } from "@/shared/types/api";

import type { InputsInferenceState } from "../../hooks/use-inputs-inference";
import { splitSum } from "../../lib/inputs-mode";
import { DEFAULT_UNIFIED_SPLIT, type InputsSlice } from "../../lib/wizard-v2";
import { SplitSection } from "../steps/SplitSection";
import { v2Msg } from "./ArtifactConfirmCard";

type MessageParams = Record<string, string | number>;

function sameSplit(a: SplitFractions, b: SplitFractions): boolean {
  return (
    Math.abs(a.train - b.train) < 1e-6 &&
    Math.abs(a.val - b.val) < 1e-6 &&
    Math.abs(a.test - b.test) < 1e-6
  );
}

/**
 * How the data is read, right under the source: each table column is an
 * Input, the Output or ignored (preselected from the inference), then the
 * train / validation / test split. A typed input shows what will be sent.
 * There is no confirm: Continue opens once the roles are valid.
 */
export function InputsColumnsCard({
  inputs,
  inference,
  patchInputs,
  issue,
  guided,
}: {
  inputs: InputsSlice;
  inference: InputsInferenceState;
  patchInputs: (p: Partial<InputsSlice>) => void;
  /** An i18n key naming what keeps the step from being done, or null. */
  issue: string | null;
  guided: boolean;
}) {
  const t = (key: string, params?: MessageParams) => v2Msg(key, guided, params);
  const { heldOut } = inference;
  const fromTable = inputs.datasetLabel !== null;
  const warnings = inference.inference?.warnings ?? [];

  const suggested = inference.inference?.suggested_split ?? DEFAULT_UNIFIED_SPLIT;
  const [manual, setManual] = React.useState(() => !sameSplit(inputs.split, suggested));
  const splitPlan: SplitPlan = {
    fractions: inputs.split,
    shuffle: inputs.shuffle,
    seed: 0,
    counts: { train: heldOut.train, val: heldOut.val, test: heldOut.test },
    engine: null,
    rationale: [],
  };
  const splitControls = {
    splitPlan,
    splitMode: manual ? ("manual" as const) : ("auto" as const),
    setSplitMode: (mode: "auto" | "manual") => {
      setManual(mode === "manual");
      if (mode === "auto") patchInputs({ split: { ...suggested } });
    },
    profileLoading: false,
    split: inputs.split,
    updateSplit: (field: keyof SplitFractions, value: string) => {
      const n = Number(value);
      if (Number.isFinite(n)) patchInputs({ split: { ...inputs.split, [field]: n } });
    },
    splitSum: splitSum(inputs.split),
  };

  return (
    <div className="flex flex-col gap-4">
      <section
        aria-labelledby="v2-inputs-columns-title"
        className="rounded-2xl border border-border/60 bg-background/70"
      >
        <div className="flex flex-col gap-1 border-b border-border/40 px-4 py-3">
          <div className="flex items-center gap-2">
            <h4 id="v2-inputs-columns-title" className="text-sm font-semibold text-foreground">
              {t("submit.v2.inputs.confirm.title")}
            </h4>
            {inference.inferring && <PingDot size="sm" tone="agent" />}
          </div>
          <p className="text-xs text-muted-foreground" dir="auto" aria-live="polite">
            {inference.inferring
              ? t("submit.v2.inputs.confirm.inferring")
              : inputs.rationale.trim() ||
                t(fromTable ? "submit.v2.inputs.roles.hint" : "submit.v2.inputs.single.preview_label")}
          </p>
          {inference.inferError && (
            <div className="flex items-center justify-between gap-3">
              <p role="alert" className="text-xs text-destructive">
                {inference.inferErrorMessage ?? t("submit.v2.inputs.confirm.infer_error")}
              </p>
              <RetryIconButton label={t("submit.v2.inputs.confirm.retry")} onClick={inference.reinfer} />
            </div>
          )}
        </div>

        <div className="flex flex-col gap-3 px-4 py-4">
          {fromTable
            ? inputs.columns.map((col) => (
                <ColumnRoleRow
                  key={col}
                  column={col}
                  role={inference.roles[col] ?? "ignore"}
                  onChangeRole={(role) => inference.setColumnRole(col, role)}
                />
              ))
            : inputs.cases[0] && (
                <pre
                  className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-muted/30 px-3 py-2 font-mono text-xs"
                  dir="ltr"
                >
                  {JSON.stringify(inputs.cases[0].input, null, 2)}
                </pre>
              )}

          {issue && (
            <p className="text-xs text-amber-700 dark:text-amber-400" aria-live="polite">
              {t(issue)}
            </p>
          )}

          {warnings.length > 0 && (
            <ul className="flex flex-col gap-1.5" aria-label={t("submit.v2.inputs.warnings_label")}>
              {warnings.map((w) => (
                <li key={w} className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400" dir="auto">
                  <Warning className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {inputs.mode === "pairs" && inputs.cases.length > 0 && (
        <SplitSection w={splitControls} totalRows={inputs.cases.length} />
      )}
    </div>
  );
}
