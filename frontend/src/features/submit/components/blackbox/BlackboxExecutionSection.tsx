"use client";

import { useEffect, useState } from "react";
import { Label } from "@/shared/ui/primitives/label";
import { Button } from "@/shared/ui/primitives/button";
import { Switch } from "@/shared/ui/primitives/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/primitives/select";
import { NumberInput } from "@/shared/ui/number-input";
import { ModelChip } from "@/shared/ui/model-chip";
import { HelpTip } from "@/shared/ui/help-tip";
import { HarnessLogo } from "@/shared/ui/harness-logo";
import { cn } from "@/shared/lib/utils";
import { BLACKBOX_HARNESSES, harnessLabel } from "@/shared/lib/blackbox-harness";
import { msg } from "@/shared/lib/messages";
import { tip } from "@/shared/lib/tooltips";
import type { BlackboxHarness } from "@/shared/types/api";

import type { BlackboxWizardContext } from "../../hooks/use-blackbox-wizard";
import { DEFAULT_TARGET_CONCURRENCY, DEFAULT_TARGET_TIMEOUT } from "../../constants";
import { Disclosure } from "../Disclosure";
import {
  Field,
  MOBILE_INPUT_CLASS,
  MOBILE_NUMBER_INPUT_CLASS,
  StepCard,
  Segmented,
  cnGrid,
} from "./shared";

const MOBILE_MODEL_CHIP_CLASS =
  "min-h-[44px] max-lg:[&_button]:min-h-[44px] max-lg:[&_button]:min-w-[44px] max-lg:[&_button]:opacity-100";

/**
 * How a candidate earns its score: handed to the evaluator as is, or acted
 * on by a coding agent in a sandbox first. The agent's harness, task model
 * and run limits only exist once that is switched on.
 */
export function BlackboxExecutionSection({ w }: { w: BlackboxWizardContext }) {
  const {
    targetKind,
    setTargetKind,
    executionMode,
    setExecutionMode,
    inferredTargetKind,
    harness,
    setHarness,
    targetModel,
    setTargetModel,
    targetTimeout,
    setTargetTimeout,
    targetConcurrency,
    setTargetConcurrency,
    setEditingModel,
    catalog,
  } = w;
  const agent = targetKind === "agent";
  const [overrideOpen, setOverrideOpen] = useState(false);
  // The limits stay folded on the defaults and open by themselves when a
  // clone or draft arrives with its own numbers.
  const customLimits =
    targetTimeout !== DEFAULT_TARGET_TIMEOUT || targetConcurrency !== DEFAULT_TARGET_CONCURRENCY;
  const [limitsOpen, setLimitsOpen] = useState(customLimits);
  useEffect(() => {
    if (customLimits) setLimitsOpen(true);
  }, [customLimits]);

  return (
    <StepCard
      title={msg("submit.blackbox.execution.title")}
      description={msg(
        agent
          ? "submit.blackbox.start.target.agent_desc"
          : "submit.blackbox.start.target.text_desc",
      )}
    >
      {inferredTargetKind === null ? (
        <Segmented<"text" | "agent">
          label={msg("submit.blackbox.start.target_label")}
          value={targetKind}
          onChange={setTargetKind}
          options={[
            {
              value: "text",
              label: msg("submit.blackbox.start.target.text"),
              desc: msg("submit.blackbox.start.target.text_desc"),
            },
            {
              value: "agent",
              label: msg("submit.blackbox.start.target.agent"),
              desc: msg("submit.blackbox.start.target.agent_desc"),
            },
          ]}
        />
      ) : (
        <Disclosure
          id="bb-execution-override"
          label={msg("submit.blackbox.optimizer.advanced")}
          open={overrideOpen}
          onOpenChange={setOverrideOpen}
        >
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
            <div className="min-w-0 space-y-0.5">
              <Label htmlFor="bb-execution-agent">
                <HelpTip
                  text={`${tip("submit.blackbox.target")} ${msg(
                    agent
                      ? "submit.blackbox.start.target.agent_desc"
                      : "submit.blackbox.start.target.text_desc",
                  )}`}
                >
                  {msg("submit.blackbox.execution.label")}
                </HelpTip>
              </Label>
            </div>
            <Switch
              id="bb-execution-agent"
              checked={agent}
              onCheckedChange={(on) => setTargetKind(on ? "agent" : "text")}
            />
          </div>
          {executionMode !== "auto" && (
            <Button type="button" variant="link" size="sm" onClick={() => setExecutionMode("auto")}>
              {msg("submit.split.mode_auto")}
            </Button>
          )}
        </Disclosure>
      )}

      <div className={cnGrid(agent)}>
        <div className="overflow-hidden">
          <div className="space-y-5 pt-2">
            <div
              id="bb-task-model"
              tabIndex={-1}
              className="min-w-0 rounded-lg outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <ModelChip
                config={targetModel}
                className={`w-full ${MOBILE_MODEL_CHIP_CLASS}`}
                tooltip={`${tip("blackbox.config.agent_model")} ${msg("submit.blackbox.roles.task.desc")}`}
                roleLabel={msg("submit.blackbox.roles.task.label")}
                required
                catalogModels={catalog?.models}
                onClick={() =>
                  setEditingModel({
                    config: targetModel,
                    onSave: setTargetModel,
                    label: msg("submit.blackbox.roles.task.label"),
                  })
                }
                onRemove={targetModel.name ? () => setTargetModel({ name: "" }) : undefined}
              />
            </div>
            <Field
              label={msg("submit.blackbox.start.harness_label")}
              tip="submit.blackbox.harness"
              htmlFor="bb-agent-harness"
            >
              <Select value={harness} onValueChange={(v) => setHarness(v as BlackboxHarness)}>
                <SelectTrigger
                  id="bb-agent-harness"
                  className={cn(
                    MOBILE_INPUT_CLASS,
                    "w-full data-[size=default]:h-auto *:data-[slot=select-value]:min-h-8",
                  )}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BLACKBOX_HARNESSES.map((h) => (
                    <SelectItem key={h} value={h}>
                      <span className="flex items-center gap-2">
                        <HarnessLogo harness={h} size={18} />
                        {harnessLabel(h)}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <div className="border-t border-border/50 pt-4">
              <Disclosure
                id="bb-execution-limits"
                label={msg("submit.blackbox.execution.limits_toggle")}
                open={limitsOpen}
                onOpenChange={setLimitsOpen}
              >
                <div className="grid gap-4 pt-1 sm:grid-cols-2">
                  <Field
                    label={msg("submit.blackbox.start.timeout_label")}
                    htmlFor="bb-target-timeout"
                    tip="submit.blackbox.target_timeout"
                  >
                    <NumberInput
                      id="bb-target-timeout"
                      value={targetTimeout}
                      onChange={setTargetTimeout}
                      min={30}
                      max={2700}
                      step={30}
                      className={MOBILE_NUMBER_INPUT_CLASS}
                    />
                  </Field>
                  <Field
                    label={msg("submit.blackbox.start.concurrency_label")}
                    htmlFor="bb-concurrency"
                    tip="submit.blackbox.concurrency"
                  >
                    <NumberInput
                      id="bb-concurrency"
                      value={targetConcurrency}
                      onChange={setTargetConcurrency}
                      min={1}
                      max={8}
                      className={MOBILE_NUMBER_INPUT_CLASS}
                    />
                  </Field>
                </div>
              </Disclosure>
            </div>
          </div>
        </div>
      </div>
    </StepCard>
  );
}
