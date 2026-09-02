"use client";

import { Label } from "@/shared/ui/primitives/label";
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
import { ModelRoleRow } from "./ModelRoleRow";
import { Field, MOBILE_INPUT_CLASS, MOBILE_NUMBER_INPUT_CLASS, StepCard, cnGrid } from "./shared";

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

  return (
    <StepCard
      title={msg("submit.blackbox.execution.title")}
      description={msg("submit.blackbox.execution.desc")}
    >
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
        <div className="min-w-0 space-y-0.5">
          <Label htmlFor="bb-execution-agent">
            <HelpTip text={tip("submit.blackbox.target")}>
              {msg("submit.blackbox.execution.label")}
            </HelpTip>
          </Label>
          <p className="text-xs text-muted-foreground">
            {msg(
              agent
                ? "submit.blackbox.start.target.agent_desc"
                : "submit.blackbox.start.target.text_desc",
            )}
          </p>
        </div>
        <Switch
          id="bb-execution-agent"
          checked={agent}
          onCheckedChange={(on) => setTargetKind(on ? "agent" : "text")}
        />
      </div>

      <div className={cnGrid(agent)}>
        <div className="overflow-hidden">
          <div className="space-y-4 pt-1">
            <ModelRoleRow
              id="bb-task-model"
              role={msg("submit.blackbox.roles.task.label")}
              modelName={targetModel.name.trim() || null}
              description={msg("submit.blackbox.roles.task.desc")}
              tip={tip("blackbox.config.agent_model")}
            >
              <ModelChip
                config={targetModel}
                className={MOBILE_MODEL_CHIP_CLASS}
                roleLabel={msg("submit.blackbox.roles.task.label")}
                required
                catalogModels={catalog?.models}
                onClick={() =>
                  setEditingModel({
                    config: targetModel,
                    onSave: setTargetModel,
                    nameOnly: true,
                    label: msg("submit.blackbox.roles.task.label"),
                  })
                }
                onRemove={targetModel.name ? () => setTargetModel({ name: "" }) : undefined}
              />
            </ModelRoleRow>
            <Field label={msg("submit.blackbox.start.harness_label")} tip="submit.blackbox.harness">
              <Select value={harness} onValueChange={(v) => setHarness(v as BlackboxHarness)}>
                <SelectTrigger
                  className={cn(
                    MOBILE_INPUT_CLASS,
                    "data-[size=default]:h-auto *:data-[slot=select-value]:min-h-8",
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
            <div className="grid gap-4 sm:grid-cols-2">
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
          </div>
        </div>
      </div>
    </StepCard>
  );
}
