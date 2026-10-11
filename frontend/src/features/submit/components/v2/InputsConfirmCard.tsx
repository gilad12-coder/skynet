"use client";

import * as React from "react";

import { Check, ListBullets, Table, Warning } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import { Segmented } from "@/shared/ui/segmented";
import { PingDot } from "@/shared/ui/ping-dot";
import { RetryIconButton } from "@/shared/ui/retry-icon-button";
import { getActiveIntlLocale } from "@/shared/lib/runtime-locale";
import { cn } from "@/shared/lib/utils";
import type { SplitFractions, SplitPlan } from "@/shared/types/api";
import type { DataMode } from "@/shared/types/unified-run";

import type { InputsInferenceState } from "../../hooks/use-inputs-inference";
import { inputsIssue, splitSum } from "../../lib/inputs-mode";
import { DEFAULT_UNIFIED_SPLIT, type InputsSlice } from "../../lib/wizard-v2";
import { Disclosure } from "../Disclosure";
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
 * How the data will be read, settled with clicks: one input or input/output
 * pairs (preselected by the inference), which columns are inputs and which
 * holds the expected output, and the automatic held-out portion. "Confirm"
 * marks the step done.
 */
export function InputsConfirmCard({
  inputs,
  inference,
  patchInputs,
  guided,
}: {
  inputs: InputsSlice;
  inference: InputsInferenceState;
  patchInputs: (p: Partial<InputsSlice>) => void;
  guided: boolean;
}) {
  const t = (key: string, params?: MessageParams) => v2Msg(key, guided, params);
  const locale = getActiveIntlLocale();
  const fmt = (n: number) => new Intl.NumberFormat(locale).format(n);
  const { heldOut } = inference;
  const issue = inputsIssue({
    mode: inputs.mode,
    caseCount: inputs.cases.length,
    inputFields: inputs.inputFields,
    expectedField: inputs.expectedField,
    split: inputs.split,
  });
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
    <section
      aria-labelledby="v2-inputs-confirm-title"
      className={cn(
        "rounded-2xl border bg-background/70 transition-colors",
        inputs.confirmed ? "border-primary-fill/50" : "border-border/60",
      )}
    >
      <div className="flex flex-col gap-1 border-b border-border/40 px-4 py-3">
        <div className="flex items-center gap-2">
          <h4 id="v2-inputs-confirm-title" className="text-sm font-semibold text-foreground">
            {t("submit.v2.inputs.confirm.title")}
          </h4>
          {inference.inferring && <PingDot size="sm" tone="agent" />}
        </div>
        <p className="text-xs text-muted-foreground" dir="auto" aria-live="polite">
          {inference.inferring
            ? t("submit.v2.inputs.confirm.inferring")
            : inputs.rationale.trim() || t("submit.v2.inputs.confirm.desc")}
        </p>
        {inference.inferError && (
          <div className="flex items-center justify-between gap-3">
            <p role="alert" className="text-xs text-destructive">
              {t("submit.v2.inputs.confirm.infer_error")}
            </p>
            <RetryIconButton label={t("submit.v2.inputs.confirm.retry")} onClick={inference.reinfer} />
          </div>
        )}
      </div>

      <div className="flex flex-col gap-5 px-4 py-4">
        <Segmented<DataMode>
          label={t("submit.v2.inputs.mode_label")}
          value={inputs.mode}
          onChange={inference.setMode}
          controls="v2-inputs-detail"
          className="w-full"
          options={[
            {
              value: "single",
              label: t("submit.v2.inputs.mode.single"),
              desc: t("submit.v2.inputs.mode.single.desc"),
              icon: <ListBullets className="size-3.5" aria-hidden="true" />,
            },
            {
              value: "pairs",
              label: t("submit.v2.inputs.mode.pairs"),
              desc: t("submit.v2.inputs.mode.pairs.desc"),
              icon: <Table className="size-3.5" aria-hidden="true" />,
            },
          ]}
        />

        <div id="v2-inputs-detail" className="flex flex-col gap-5">
          {inputs.mode === "single" && inputs.cases[0] && (
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-foreground">
                {t("submit.v2.inputs.single.preview_label")}
              </span>
              <pre
                className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-muted/30 px-3 py-2 font-mono text-xs"
                dir="ltr"
              >
                {JSON.stringify(inputs.cases[0].input, null, 2)}
              </pre>
            </div>
          )}

          {inputs.mode === "pairs" && inputs.columns.length > 0 && (
            <>
              <ChipGroup
                label={t("submit.v2.inputs.pairs.input_fields")}
                hint={t("submit.v2.inputs.pairs.input_fields_hint")}
              >
                {inputs.columns.map((col) => (
                  <Chip
                    key={col}
                    label={col}
                    pressed={inputs.inputFields.includes(col)}
                    disabled={col === inputs.expectedField}
                    onClick={() => inference.toggleInputField(col)}
                  />
                ))}
              </ChipGroup>
              <ChipGroup
                label={t("submit.v2.inputs.pairs.expected_field")}
                hint={t("submit.v2.inputs.pairs.expected_field_hint")}
              >
                <Chip
                  label={t("submit.v2.inputs.pairs.expected_none")}
                  pressed={inputs.expectedField === null}
                  onClick={() => inference.setExpectedField(null)}
                  plain
                />
                {inputs.columns.map((col) => (
                  <Chip
                    key={col}
                    label={col}
                    pressed={inputs.expectedField === col}
                    onClick={() => inference.setExpectedField(col)}
                  />
                ))}
              </ChipGroup>
            </>
          )}

          {inputs.mode === "pairs" && inputs.cases.length > 0 && (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-foreground" aria-live="polite">
                {heldOut.heldOut
                  ? t("submit.v2.inputs.held_out.count", {
                      count: fmt(heldOut.test),
                      total: fmt(inputs.cases.length),
                    })
                  : t("submit.v2.inputs.held_out.none")}
              </p>
              <Disclosure
                id="v2-inputs-split"
                label={t("submit.v2.inputs.held_out.adjust")}
                open={manual}
                onOpenChange={(open) => (open ? setManual(true) : splitControls.setSplitMode("auto"))}
              >
                <SplitSection w={splitControls} totalRows={inputs.cases.length} />
              </Disclosure>
            </div>
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
      </div>

      <div className="flex flex-col items-stretch gap-2 border-t border-border/40 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <p
          className={cn(
            "text-xs",
            inputs.confirmed ? "text-[#5A7247] dark:text-[#adc899]" : "text-muted-foreground",
          )}
          aria-live="polite"
        >
          {inputs.confirmed
            ? t("submit.v2.inputs.confirmed")
            : issue
              ? t(issue)
              : t("submit.v2.inputs.confirm_hint")}
        </p>
        <Button
          type="button"
          onClick={() => patchInputs({ confirmed: true })}
          disabled={inputs.confirmed || !!issue || inference.inferring}
          className="min-h-11 gap-2 lg:min-h-9"
        >
          <Check className="size-4" aria-hidden="true" />
          {t("submit.v2.inputs.confirm")}
        </Button>
      </div>
    </section>
  );
}

function ChipGroup({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-foreground">{label}</span>
      <p className="text-xs text-muted-foreground">{hint}</p>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

function Chip({
  label,
  pressed,
  disabled,
  onClick,
  plain,
}: {
  label: string;
  pressed: boolean;
  disabled?: boolean;
  onClick: () => void;
  /** A worded choice rather than a column name. */
  plain?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      dir={plain ? undefined : "ltr"}
      title={label}
      className={cn(
        "inline-flex min-h-11 max-w-full items-center gap-1.5 truncate rounded-full border px-3 text-xs transition-colors lg:min-h-8",
        plain ? "" : "font-mono",
        pressed
          ? "border-primary-fill bg-primary-fill text-primary-foreground"
          : "border-border bg-background text-foreground hover:border-primary-fill/60",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45 disabled:cursor-not-allowed disabled:opacity-50",
      )}
    >
      {pressed && <Check className="size-3 shrink-0" aria-hidden="true" />}
      <span className="truncate">{label}</span>
    </button>
  );
}
