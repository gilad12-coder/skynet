"use client";

import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ArrowLeft, ArrowRight, Check } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/primitives/select";
import { formatMsg, msg, type MessageKey } from "@/shared/lib/messages";
import { ConnectorSourcePicker, type ConnectorSource } from "@/features/connectors";
import type {
  ContinuousEnableRequest,
  ContinuousPermitted,
  ScheduleRule,
} from "@/shared/types/continuous";
import { cn } from "@/shared/lib/utils";
import { enableProblem } from "../lib/continuous";
import { browserTimeZone, defaultRule, scheduleProblem } from "../lib/continuous-schedule";
import { ScheduleEditor } from "./ScheduleEditor";

type RefreshKind = keyof ContinuousPermitted;
type WalkStep = "refresh" | "source" | "schedule";

const STEP_TITLES: Record<WalkStep, MessageKey> = {
  refresh: "continuous_tab.permit.label",
  source: "continuous_tab.source.label",
  schedule: "continuous_tab.schedule.label",
};

const REFRESH_KEYS: Record<RefreshKind, MessageKey> = {
  data: "continuous_tab.permit.data",
  models: "continuous_tab.permit.models",
  optimizers: "continuous_tab.permit.optimizers",
};

/** The request a finished walk sends; only a data refresh carries a source. */
function requestFor(
  kind: RefreshKind,
  source: ConnectorSource | null,
  schedule: ScheduleRule,
): ContinuousEnableRequest {
  const permitted: ContinuousPermitted = {
    data: kind === "data",
    models: kind === "models",
    optimizers: kind === "optimizers",
  };
  return {
    schedule,
    permitted,
    source: permitted.data && source ? { provider: source.provider, ref: source.ref } : null,
  };
}

/**
 * Walks the scheduled-run settings one screen at a time, like the submit
 * wizard: what may refresh, where the data comes from, then the schedule.
 */
export function ScheduledRunSetup({
  busy = false,
  finishLabel,
  onFinish,
  idPrefix,
}: {
  busy?: boolean;
  finishLabel: MessageKey;
  onFinish: (body: ContinuousEnableRequest) => void;
  idPrefix: string;
}) {
  const [kind, setKind] = useState<RefreshKind>("data");
  const [source, setSource] = useState<ConnectorSource | null>(null);
  const [schedule, setSchedule] = useState<ScheduleRule>(() => defaultRule(browserTimeZone()));
  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState(1);
  const reduceMotion = useReducedMotion();

  const steps: WalkStep[] =
    kind === "data" ? ["refresh", "source", "schedule"] : ["refresh", "schedule"];
  const at = Math.min(index, steps.length - 1);
  const step = steps[at]!;
  const last = at === steps.length - 1;
  const body = requestFor(kind, source, schedule);

  const stepProblem =
    step === "source"
      ? enableProblem({ permitted: body.permitted, sourceRef: source?.ref ?? "" })
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
            {step === "refresh" && (
              <div className="space-y-4">
                <p className="text-center text-base font-medium text-foreground">
                  {msg("continuous_tab.walk.refresh_hint")}
                </p>
                <Select value={kind} onValueChange={(v) => setKind(v as RefreshKind)}>
                  <SelectTrigger
                    className="h-11 w-full"
                    aria-label={msg("continuous_tab.permit.label")}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(["data", "models", "optimizers"] as const).map((key) => (
                      <SelectItem key={key} value={key}>
                        {msg(REFRESH_KEYS[key])}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {step === "source" && (
              <div className="space-y-4">
                <p className="text-center text-base font-medium text-foreground">
                  {msg("continuous_tab.walk.source_hint")}
                </p>
                <ConnectorSourcePicker value={source} onChange={setSource} />
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
