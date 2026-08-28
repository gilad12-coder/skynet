"use client";

import { Plus, Trash } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import { Input } from "@/shared/ui/primitives/input";
import { Separator } from "@/shared/ui/primitives/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/primitives/select";
import { NumberInput } from "@/shared/ui/number-input";
import { msg } from "@/shared/lib/messages";
import type { BlackboxHarness } from "@/shared/types/api";

import type { BlackboxWizardContext, SeedMode } from "../../hooks/use-blackbox-wizard";
import { ArtifactStatusChip } from "../steps/AuthoringShell";
import { VersionStepper } from "../steps/CodeAgentPanel";
import { BlackboxAuthoringShell } from "./BlackboxAuthoringShell";
import {
  Field,
  MOBILE_INPUT_CLASS,
  MOBILE_NUMBER_INPUT_CLASS,
  Segmented,
  TEXTAREA_CLASS,
} from "./shared";

const HARNESSES: BlackboxHarness[] = ["pi", "codex", "opencode", "custom"];

export function BlackboxStartStep({ w }: { w: BlackboxWizardContext }) {
  const {
    recipe,
    codeAssistMode,
    agent,
    setSeedManuallyEdited,
    seedMode,
    setSeedMode,
    seedText,
    setSeedText,
    seedParts,
    setSeedParts,
    objective,
    setObjective,
    setObjectiveEditing,
    background,
    setBackground,
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
    setupCommand,
    setSetupCommand,
    installCommand,
    setInstallCommand,
    runCommand,
    setRunCommand,
    catalog,
  } = w;

  const updatePart = (i: number, patch: { key?: string; value?: string }) =>
    setSeedParts(seedParts.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));

  // Each recipe names its starting point in its own words; "anything" keeps
  // the generic copy.
  const seedLabel =
    recipe === "prompt"
      ? msg("submit.blackbox.start.seed_label_prompt")
      : recipe === "code"
        ? msg("submit.blackbox.start.seed_label_code")
        : msg("submit.blackbox.start.seed_label");
  const seedPlaceholder =
    codeAssistMode === "auto"
      ? msg("submit.blackbox.start.seed_placeholder_auto")
      : recipe === "prompt"
        ? msg("submit.blackbox.start.seed_placeholder_prompt")
        : recipe === "code"
          ? msg("submit.blackbox.start.seed_placeholder_code")
          : msg("submit.blackbox.start.seed_placeholder");

  const seedFields = (
    <>
      <Segmented<SeedMode>
        value={seedMode}
        onChange={setSeedMode}
        options={[
          {
            value: "text",
            label: msg("submit.blackbox.start.seed_mode.text"),
            desc: msg("submit.blackbox.start.seed_mode.text_desc"),
          },
          {
            value: "parts",
            label: msg("submit.blackbox.start.seed_mode.parts"),
            desc: msg("submit.blackbox.start.seed_mode.parts_desc"),
          },
          {
            value: "none",
            label: msg("submit.blackbox.start.seed_mode.none"),
            desc: msg("submit.blackbox.start.seed_mode.none_desc"),
          },
        ]}
      />
      {codeAssistMode === "auto" && seedMode !== "text" && (
        <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
          {msg("submit.blackbox.start.seed_mode_hint_auto")}
        </p>
      )}

      {seedMode === "text" && (
        <Field
          label={seedLabel}
          htmlFor="bb-seed"
          hint={codeAssistMode === "auto" ? msg("submit.blackbox.start.seed_hint_auto") : undefined}
          trailing={
            codeAssistMode === "auto" ? (
              <>
                <VersionStepper agent={agent} artifact="signature" />
                <ArtifactStatusChip status={agent.signatureStatus} />
              </>
            ) : undefined
          }
        >
          <textarea
            id="bb-seed"
            value={seedText}
            onChange={(e) => {
              setSeedText(e.target.value);
              setSeedManuallyEdited(true);
            }}
            placeholder={seedPlaceholder}
            rows={8}
            dir="auto"
            className={`${TEXTAREA_CLASS} font-mono text-sm`}
          />
        </Field>
      )}

      {seedMode === "parts" && (
        <div className="space-y-3">
          {seedParts.map((part, i) => (
            <div key={i} className="space-y-2 rounded-lg border border-border/50 p-3">
              <div className="flex items-center gap-2">
                <Input
                  value={part.key}
                  onChange={(e) => updatePart(i, { key: e.target.value })}
                  placeholder={msg("submit.blackbox.start.part_key")}
                  className={`${MOBILE_INPUT_CLASS} font-mono`}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={msg("submit.blackbox.start.remove_part")}
                  disabled={seedParts.length === 1}
                  onClick={() => setSeedParts(seedParts.filter((_, idx) => idx !== i))}
                  className="shrink-0"
                >
                  <Trash className="size-4" />
                </Button>
              </div>
              <textarea
                value={part.value}
                onChange={(e) => updatePart(i, { value: e.target.value })}
                placeholder={msg("submit.blackbox.start.part_value")}
                rows={4}
                dir="auto"
                className={`${TEXTAREA_CLASS} font-mono text-sm`}
              />
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            onClick={() => setSeedParts([...seedParts, { key: "", value: "" }])}
            className="min-h-[44px] gap-2 lg:min-h-0"
          >
            <Plus className="size-4" />
            {msg("submit.blackbox.start.add_part")}
          </Button>
        </div>
      )}
    </>
  );

  const objectiveFields = (
    <>
      <Field
        label={msg("submit.blackbox.start.objective_label")}
        htmlFor="bb-objective"
        hint={
          codeAssistMode === "auto"
            ? msg("submit.blackbox.start.objective_hint_auto")
            : msg("submit.blackbox.start.objective_hint")
        }
      >
        <textarea
          id="bb-objective"
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          onFocus={() => setObjectiveEditing(true)}
          onBlur={() => setObjectiveEditing(false)}
          placeholder={msg("submit.blackbox.start.objective_placeholder")}
          rows={3}
          dir="auto"
          className={TEXTAREA_CLASS}
        />
      </Field>
      <Field label={msg("submit.blackbox.start.background_label")} htmlFor="bb-background">
        <textarea
          id="bb-background"
          value={background}
          onChange={(e) => setBackground(e.target.value)}
          placeholder={msg("submit.blackbox.start.background_placeholder")}
          rows={3}
          dir="auto"
          className={TEXTAREA_CLASS}
        />
      </Field>
    </>
  );

  return (
    <BlackboxAuthoringShell
      w={w}
      title={msg("submit.blackbox.start.title")}
      description={msg("submit.blackbox.start.desc")}
    >
      {/* Agent-led authoring starts from the objective and the seed follows as
          the agent's output; hand authoring leads with the seed itself. */}
      {codeAssistMode === "auto" ? (
        <>
          {objectiveFields}
          {seedFields}
        </>
      ) : (
        <>
          {seedFields}
          {objectiveFields}
        </>
      )}

      <Separator />

      <Field label={msg("submit.blackbox.start.target_label")}>
        <Segmented<"text" | "agent">
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
      </Field>

      {targetKind === "agent" && (
        <div className="space-y-4 rounded-lg border border-border/50 bg-muted/20 p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={msg("submit.blackbox.start.harness_label")}>
              <Select value={harness} onValueChange={(v) => setHarness(v as BlackboxHarness)}>
                <SelectTrigger className={MOBILE_INPUT_CLASS}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HARNESSES.map((h) => (
                    <SelectItem key={h} value={h}>
                      {h}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={msg("submit.blackbox.start.agent_model_label")}>
              <Select value={targetModel} onValueChange={setTargetModel}>
                <SelectTrigger className={MOBILE_INPUT_CLASS}>
                  <SelectValue placeholder={msg("submit.blackbox.start.agent_model_placeholder")} />
                </SelectTrigger>
                <SelectContent>
                  {(catalog?.models ?? []).map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={msg("submit.blackbox.start.timeout_label")} htmlFor="bb-target-timeout">
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
            <Field label={msg("submit.blackbox.start.concurrency_label")} htmlFor="bb-concurrency">
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
          {(
            [
              [
                "setup",
                msg("submit.blackbox.start.setup_command"),
                setupCommand,
                setSetupCommand,
                false,
              ],
              [
                "install",
                msg("submit.blackbox.start.install_command"),
                installCommand,
                setInstallCommand,
                false,
              ],
              [
                "run",
                msg("submit.blackbox.start.run_command"),
                runCommand,
                setRunCommand,
                harness === "custom",
              ],
            ] as const
          ).map(([key, label, value, setValue, required]) => (
            <Field
              key={key}
              htmlFor={`bb-${key}-command`}
              label={
                <>
                  {label}
                  {!required && (
                    <span className="ms-1 font-normal text-muted-foreground">
                      {msg("submit.blackbox.start.commands_optional")}
                    </span>
                  )}
                </>
              }
            >
              <Input
                id={`bb-${key}-command`}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                dir="ltr"
                className={`${MOBILE_INPUT_CLASS} font-mono`}
              />
            </Field>
          ))}
        </div>
      )}
    </BlackboxAuthoringShell>
  );
}
