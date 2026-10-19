"use client";

import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ArrowLeft, ArrowRight, Check } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import { Input } from "@/shared/ui/primitives/input";
import { Switch } from "@/shared/ui/primitives/switch";
import { formatMsg, msg, type MessageKey } from "@/shared/lib/messages";
import { ConnectorSourcePicker, type ConnectorSource } from "@/features/connectors";
import type {
  ContinuousEnableRequest,
  ContinuousMatrixRun,
  ScheduleRule,
} from "@/shared/types/continuous";
import { cn } from "@/shared/lib/utils";
import { enableProblem, minCasesProblem } from "../lib/continuous";
import { browserTimeZone, defaultRule, scheduleProblem } from "../lib/continuous-schedule";
import { ScheduleEditor } from "./ScheduleEditor";

type WalkStep = "source" | "schedule";

const STEPS: WalkStep[] = ["source", "schedule"];

const STEP_TITLES: Record<WalkStep, MessageKey> = {
  source: "continuous_tab.walk.triggers",
  schedule: "continuous_tab.schedule.label",
};

const MATRIX: Array<{ run: ContinuousMatrixRun; label: MessageKey }> = [
  { run: "data", label: "continuous_tab.matrix.data" },
  { run: "model", label: "continuous_tab.matrix.model" },
  { run: "both", label: "continuous_tab.matrix.both" },
];

export interface SetupChoices {
  data: boolean;
  /** The minimum of new or changed cases as typed; empty means the default. */
  minCases: string;
  newTaskModel: boolean;
  newReflectionModel: boolean;
  matrix: ContinuousMatrixRun[];
}

/**
 * The request a finished walk sends. A plan may refresh its data, try a
 * better model in either role, or both. Nothing yet stages a model or
 * optimizer by hand from here, so those stay off.
 */
export function requestFor(
  choices: SetupChoices,
  source: ConnectorSource | null,
  schedule: ScheduleRule,
): ContinuousEnableRequest {
  const minCases = choices.minCases.trim();
  return {
    schedule,
    permitted: {
      data: choices.data,
      models: false,
      optimizers: false,
      new_task_model: choices.newTaskModel,
      new_reflection_model: choices.newReflectionModel,
      min_new_cases: choices.data && minCases ? Number(minCases) : null,
      matrix: choices.matrix,
    },
    source: choices.data && source ? { provider: source.provider, ref: source.ref } : null,
  };
}

function modelHint(model: string | null | undefined): string {
  return model
    ? formatMsg("continuous_tab.permit.better_model_hint", { model })
    : msg("continuous_tab.permit.better_model_hint_unknown");
}

function TriggerRow({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string;
  label: MessageKey;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <label htmlFor={id} className="cursor-pointer text-sm font-medium text-foreground">
          {msg(label)}
        </label>
        <p className="text-sm text-muted-foreground">{hint}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} className="mt-0.5" />
    </div>
  );
}

/**
 * Walks the scheduled-run settings one screen at a time, like the submit
 * wizard: what starts a run, then the schedule. The model names say which
 * models a better-model check compares against.
 */
export function ScheduledRunSetup({
  busy = false,
  finishLabel,
  onFinish,
  idPrefix,
  taskModel,
  reflectionModel,
}: {
  busy?: boolean;
  finishLabel: MessageKey;
  onFinish: (body: ContinuousEnableRequest) => void;
  idPrefix: string;
  taskModel?: string | null;
  reflectionModel?: string | null;
}) {
  const [choices, setChoices] = useState<SetupChoices>({
    data: true,
    minCases: "",
    newTaskModel: false,
    newReflectionModel: false,
    matrix: ["both"],
  });
  const choose = (patch: Partial<SetupChoices>) => setChoices((prev) => ({ ...prev, ...patch }));
  const [source, setSource] = useState<ConnectorSource | null>(null);
  const [schedule, setSchedule] = useState<ScheduleRule>(() => defaultRule(browserTimeZone()));
  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState(1);
  const reduceMotion = useReducedMotion();

  const steps = STEPS;
  const at = Math.min(index, steps.length - 1);
  const step = steps[at]!;
  const last = at === steps.length - 1;
  const body = requestFor(choices, source, schedule);
  const { data } = choices;
  const newModel = choices.newTaskModel || choices.newReflectionModel;

  const stepProblem =
    step === "source"
      ? (enableProblem({ permitted: body.permitted, sourceRef: source?.ref ?? "" }) ??
        (data ? minCasesProblem(choices.minCases) : null))
      : step === "schedule"
        ? scheduleProblem(schedule)
        : null;

  const move = (to: number) => {
    setDirection(to > at ? 1 : -1);
    setIndex(to);
  };
  const next = () => {
    if (stepProblem != null || busy) return;
    if (last) onFinish(body);
    else move(at + 1);
  };

  // The screens slide the way reading runs, so a Hebrew walk moves right to left.
  const rtl = typeof document !== "undefined" && document.dir === "rtl";
  const offset = reduceMotion ? 0 : 32 * direction * (rtl ? -1 : 1);

  return (
    <div className="mx-auto flex w-full max-w-[39rem] flex-col gap-6 px-5 pt-6 pb-6 sm:px-6 sm:pt-8">
      <ol
        className="flex flex-wrap items-center justify-center gap-2"
        aria-label={msg("continuous_tab.walk.steps")}
      >
        {steps.map((s, i) => {
          const done = i < at;
          const current = i === at;
          return (
            <li key={s} className="flex items-center gap-2">
              {i > 0 && (
                <span
                  aria-hidden
                  className={cn(
                    "h-px w-6 transition-colors duration-300",
                    i <= at ? "bg-primary" : "bg-border",
                  )}
                />
              )}
              <button
                type="button"
                disabled={!done}
                onClick={() => move(i)}
                aria-current={current ? "step" : undefined}
                className={cn(
                  "inline-flex items-center gap-2 rounded-full py-1 pe-3 ps-1 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  current && "bg-primary/10 font-medium text-foreground",
                  done && "text-foreground hover:bg-muted",
                  !current && !done && "text-muted-foreground",
                )}
              >
                <span
                  className={cn(
                    "inline-flex size-6 items-center justify-center rounded-full text-xs font-semibold tabular-nums transition-colors duration-300",
                    current && "bg-primary text-primary-foreground",
                    done && "bg-primary/15 text-primary",
                    !current && !done && "bg-muted text-muted-foreground",
                  )}
                >
                  {done ? <Check className="size-3.5" aria-hidden /> : i + 1}
                </span>
                {msg(STEP_TITLES[s])}
              </button>
            </li>
          );
        })}
      </ol>

      <div className="relative">
        <AnimatePresence mode="wait" initial={false} custom={offset}>
          <motion.div
            key={step}
            initial={{ opacity: 0, x: offset }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -offset }}
            transition={{ duration: reduceMotion ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="space-y-4"
          >
            {step === "source" && (
              <div className="space-y-5">
                <p className="text-center text-base font-medium text-foreground">
                  {msg("continuous_tab.walk.refresh_hint")}
                </p>
                <TriggerRow
                  id={`${idPrefix}-data`}
                  label="continuous_tab.permit.data"
                  hint={msg("continuous_tab.walk.source_hint")}
                  checked={data}
                  onChange={(next) => choose({ data: next })}
                />
                {data && (
                  <div className="space-y-4">
                    <ConnectorSourcePicker value={source} onChange={setSource} />
                    <div className="space-y-1.5">
                      <label
                        htmlFor={`${idPrefix}-min-cases`}
                        className="text-sm font-medium text-foreground"
                      >
                        {msg("continuous_tab.permit.min_new_cases")}
                      </label>
                      <Input
                        id={`${idPrefix}-min-cases`}
                        type="number"
                        inputMode="numeric"
                        min={1}
                        step={1}
                        dir="ltr"
                        className="w-32"
                        value={choices.minCases}
                        placeholder={msg("continuous_tab.permit.min_new_cases_placeholder")}
                        onChange={(e) => choose({ minCases: e.target.value })}
                        aria-describedby={`${idPrefix}-min-cases-hint`}
                      />
                      <p
                        id={`${idPrefix}-min-cases-hint`}
                        className={cn(
                          "text-sm",
                          minCasesProblem(choices.minCases)
                            ? "text-destructive"
                            : "text-muted-foreground",
                        )}
                      >
                        {msg(
                          minCasesProblem(choices.minCases) ??
                            "continuous_tab.permit.min_new_cases_hint",
                        )}
                      </p>
                    </div>
                  </div>
                )}
                <TriggerRow
                  id={`${idPrefix}-new-task-model`}
                  label="continuous_tab.permit.new_task_model"
                  hint={modelHint(taskModel)}
                  checked={choices.newTaskModel}
                  onChange={(next) => choose({ newTaskModel: next })}
                />
                <TriggerRow
                  id={`${idPrefix}-new-reflection-model`}
                  label="continuous_tab.permit.new_reflection_model"
                  hint={modelHint(reflectionModel)}
                  checked={choices.newReflectionModel}
                  onChange={(next) => choose({ newReflectionModel: next })}
                />
                {data && newModel && (
                  <fieldset className="space-y-2 rounded-lg border border-border/60 p-4">
                    <legend className="px-1 text-sm font-medium text-foreground">
                      {msg("continuous_tab.matrix.label")}
                    </legend>
                    <p className="text-sm text-muted-foreground">
                      {msg("continuous_tab.matrix.hint")}
                    </p>
                    <div className="flex flex-wrap gap-2 pt-1">
                      {MATRIX.map(({ run, label }) => {
                        const on = choices.matrix.includes(run);
                        // One run must stay ticked, so the last one cannot be cleared.
                        const locked = on && choices.matrix.length === 1;
                        return (
                          <button
                            key={run}
                            type="button"
                            aria-pressed={on}
                            disabled={locked}
                            onClick={() =>
                              choose({
                                matrix: on
                                  ? choices.matrix.filter((r) => r !== run)
                                  : MATRIX.map((m) => m.run).filter(
                                      (r) => r === run || choices.matrix.includes(r),
                                    ),
                              })
                            }
                            className={cn(
                              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default",
                              on
                                ? "border-primary bg-primary/10 font-medium text-foreground"
                                : "border-border text-muted-foreground hover:bg-muted",
                            )}
                          >
                            {on && <Check className="size-3.5" aria-hidden />}
                            {msg(label)}
                          </button>
                        );
                      })}
                    </div>
                  </fieldset>
                )}
              </div>
            )}

            {step === "schedule" && (
              <ScheduleEditor value={schedule} onChange={setSchedule} idPrefix={idPrefix} />
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 border-t border-border/50 pt-5">
        <div className="justify-self-start">
          {at > 0 && (
            <Button type="button" variant="ghost" onClick={() => move(at - 1)} disabled={busy}>
              <ArrowLeft className="size-4 rtl:rotate-180" aria-hidden />
              {msg("continuous_tab.walk.back")}
            </Button>
          )}
        </div>
        {/* The same moving dots as the submit wizard, so both walks read alike. */}
        <div
          className="flex items-center gap-1.5"
          role="img"
          aria-label={formatMsg("continuous_tab.walk.position", { n: at + 1, total: steps.length })}
        >
          {steps.map((s, i) => (
            <span
              key={s}
              className={cn(
                "h-1.5 rounded-full transition-all duration-300",
                i === at ? "w-4 bg-primary-fill" : "w-1.5 bg-muted-foreground/30",
              )}
            />
          ))}
        </div>
        <Button
          type="button"
          className="justify-self-end"
          onClick={next}
          disabled={stepProblem != null || busy}
        >
          {msg(last ? finishLabel : "continuous_tab.walk.next")}
          {!last && <ArrowRight className="size-4 rtl:rotate-180" aria-hidden />}
        </Button>
      </div>
    </div>
  );
}
