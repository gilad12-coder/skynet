"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
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
import { ModelChip } from "@/shared/ui/model-chip";
import { HarnessLogo } from "@/shared/ui/harness-logo";
import { BLACKBOX_HARNESSES, harnessLabel } from "@/shared/lib/blackbox-harness";
import { msg } from "@/shared/lib/messages";
import { tip as tipText } from "@/shared/lib/tooltips";
import { HelpTip } from "@/shared/ui/help-tip";
import type { BlackboxHarness } from "@/shared/types/api";

import type {
  BlackboxRecipe,
  BlackboxWizardContext,
  SeedMode,
} from "../../hooks/use-blackbox-wizard";
import { emptyModelConfig } from "../../constants";
import { detectLanguage, looksLikeCode, type SeedLanguage } from "../../lib/seed-format";
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

type SeedFormat = "text" | "code";
interface SeedGuess {
  code: boolean;
  language: SeedLanguage | null;
}
const NO_GUESS: SeedGuess = { code: false, language: null };

const MOBILE_MODEL_CHIP_CLASS =
  "min-h-[44px] max-lg:[&_button]:min-h-[44px] max-lg:[&_button]:min-w-[44px] max-lg:[&_button]:opacity-100";

const CodeEditor = dynamic(() => import("@/shared/ui/code-editor").then((m) => m.CodeEditor), {
  ssr: false,
});

export function BlackboxStartStep({ w }: { w: BlackboxWizardContext }) {
  const {
    recipe,
    setRecipe,
    codeAssistMode,
    interviewEligible,
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
    setEditingModel,
    catalog,
  } = w;

  const updatePart = (i: number, patch: { key?: string; value?: string }) =>
    setSeedParts(seedParts.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));

  // What the seed reads as, latched until the seed is cleared so the editor
  // never swaps out from under the caret while a snippet is typed or trimmed.
  // A format picked by hand outranks the guess; the code kind is always code.
  const [seedGuess, setSeedGuess] = useState<SeedGuess>(NO_GUESS);
  const [seedFormatChoice, setSeedFormatChoice] = useState<SeedFormat | null>(null);
  useEffect(() => {
    if (!seedText.trim()) {
      setSeedGuess(NO_GUESS);
      setSeedFormatChoice(null);
      return;
    }
    const language = detectLanguage(seedText);
    if (!language && !looksLikeCode(seedText)) return;
    setSeedGuess((prev) =>
      prev.code && (!language || prev.language === language)
        ? prev
        : { code: true, language: language ?? prev.language },
    );
  }, [seedText]);
  const seedFormat: SeedFormat =
    recipe === "code" ? "code" : (seedFormatChoice ?? (seedGuess.code ? "code" : "text"));
  const seedIsCode = seedFormat === "code";
  const seedLanguage = seedGuess.language ?? (recipe === "code" ? "Python" : "text");

  // The code kind names its starting point in its own words; text keeps the
  // generic copy.
  const seedLabel =
    recipe === "code"
      ? msg("submit.blackbox.start.seed_label_code")
      : msg("submit.blackbox.start.seed_label");
  const seedPlaceholder =
    recipe === "code"
      ? msg("submit.blackbox.start.seed_placeholder_code")
      : msg("submit.blackbox.start.seed_placeholder");
  // One line of guidance at most: what the interview does while it is live,
  // otherwise only the code recipe needs a nudge about what to paste.
  const seedHint = interviewEligible
    ? seedMode === "text"
      ? msg("submit.blackbox.start.seed_hint_auto")
      : msg("submit.blackbox.start.seed_mode_hint_auto")
    : seedMode === "text" && recipe === "code"
      ? seedPlaceholder
      : undefined;

  const showSeedFormat = seedMode === "text" && recipe !== "code";
  // The stepper and status chip mean nothing until the agent has touched the
  // seed; idle they render empty and would leave a hollow label row.
  const showSeedAgent = interviewEligible && agent.signatureStatus !== "idle";
  const seedTrailing =
    showSeedFormat || showSeedAgent ? (
      <>
        {showSeedFormat && (
          <HelpTip text={tipText("submit.blackbox.seed_format")}>
            <Segmented<SeedFormat>
              compact
              value={seedFormat}
              onChange={setSeedFormatChoice}
              options={[
                { value: "text", label: msg("submit.blackbox.start.seed_format.text") },
                { value: "code", label: msg("submit.blackbox.start.seed_format.code") },
              ]}
            />
          </HelpTip>
        )}
        {showSeedAgent && (
          <>
            <VersionStepper agent={agent} artifact="signature" />
            <ArtifactStatusChip status={agent.signatureStatus} />
          </>
        )}
      </>
    ) : undefined;

  const seedFields = (
    <Field
      label={seedLabel}
      tip="submit.blackbox.seed"
      htmlFor={seedMode === "text" && !seedIsCode ? "bb-seed" : undefined}
      hint={seedHint}
      trailing={seedTrailing}
    >
      <Segmented<SeedMode>
        value={seedMode}
        onChange={setSeedMode}
        options={[
          { value: "text", label: msg("submit.blackbox.start.seed_mode.text") },
          { value: "parts", label: msg("submit.blackbox.start.seed_mode.parts") },
          { value: "none", label: msg("submit.blackbox.start.seed_mode.none") },
        ]}
      />

      {seedMode === "text" &&
        (seedIsCode ? (
          <CodeEditor
            value={seedText}
            onChange={(v) => {
              setSeedText(v);
              setSeedManuallyEdited(true);
            }}
            height="300px"
            language={seedLanguage}
            label={seedGuess.language ?? msg("submit.blackbox.start.seed_editor_label")}
            streaming={codeAssistMode === "auto" && agent.signatureStatus === "writing"}
            flashLines={codeAssistMode === "auto" ? agent.signatureFlashLines : undefined}
          />
        ) : (
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
        ))}

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
    </Field>
  );

  const objectiveFields = (
    <>
      <Field
        label={msg("submit.blackbox.start.objective_label")}
        tip="submit.blackbox.objective"
        htmlFor="bb-objective"
        hint={interviewEligible ? msg("submit.blackbox.start.objective_hint_auto") : undefined}
      >
        <textarea
          id="bb-objective"
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          placeholder={msg("submit.blackbox.start.objective_placeholder")}
          rows={3}
          dir="auto"
          className={TEXTAREA_CLASS}
        />
      </Field>
      <Field
        label={msg("submit.blackbox.start.background_label")}
        htmlFor="bb-background"
        tip="submit.blackbox.background"
      >
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
      {/* The kind names what the seed is — it sets the seed's label and editor,
          the scorer's default and what the copilot writes — so it leads both
          orderings below. */}
      <Field label={msg("submit.blackbox.start.kind_label")} tip="submit.blackbox.kind">
        <Segmented<BlackboxRecipe>
          value={recipe}
          onChange={setRecipe}
          options={[
            {
              value: "anything",
              label: msg("submit.blackbox.start.kind.anything"),
              desc: msg("submit.blackbox.start.kind.anything_desc"),
            },
            {
              value: "code",
              label: msg("submit.blackbox.start.kind.code"),
              desc: msg("submit.blackbox.start.kind.code_desc"),
            },
          ]}
        />
      </Field>

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

      <Field label={msg("submit.blackbox.start.target_label")} tip="submit.blackbox.target">
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
            <Field label={msg("submit.blackbox.start.harness_label")} tip="submit.blackbox.harness">
              <Select value={harness} onValueChange={(v) => setHarness(v as BlackboxHarness)}>
                <SelectTrigger className={MOBILE_INPUT_CLASS}>
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
            <Field
              label={msg("submit.blackbox.start.agent_model_label")}
              tip="blackbox.config.agent_model"
            >
              <ModelChip
                config={targetModel}
                className={MOBILE_MODEL_CHIP_CLASS}
                required
                catalogModels={catalog?.models}
                onClick={() =>
                  setEditingModel({
                    config: targetModel,
                    onSave: setTargetModel,
                    label: msg("submit.blackbox.start.agent_model_label"),
                  })
                }
                onRemove={targetModel.name ? () => setTargetModel(emptyModelConfig()) : undefined}
              />
            </Field>
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
      )}
    </BlackboxAuthoringShell>
  );
}
