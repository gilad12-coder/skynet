"use client";

import type { ReactNode } from "react";
import dynamic from "next/dynamic";
import { Plus, Trash } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import { Input } from "@/shared/ui/primitives/input";
import { msg } from "@/shared/lib/messages";

import type { BlackboxWizardContext } from "../../hooks/use-blackbox-wizard";
import { ArtifactStatusChip } from "../steps/AuthoringShell";
import { VersionStepper } from "../steps/CodeAgentPanel";
import { BlackboxAuthoringShell } from "./BlackboxAuthoringShell";
import { ExpandableTextarea } from "@/shared/ui/expandable-textarea";
import { Field, MOBILE_INPUT_CLASS, TEXTAREA_CLASS } from "./shared";

const CodeEditor = dynamic(() => import("@/shared/ui/code-editor").then((m) => m.CodeEditor), {
  ssr: false,
});

// The seed's shape is a side choice, not a question the form asks: each
// alternative is a quiet text action under the editor.
function SeedAction({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <Button
      type="button"
      variant="link"
      size="sm"
      onClick={onClick}
      className="min-h-[44px] gap-1 px-0 text-xs text-muted-foreground hover:text-foreground lg:min-h-0"
    >
      {children}
    </Button>
  );
}

export function BlackboxStartStep({
  w,
  header,
}: {
  w: BlackboxWizardContext;
  // The recipe chip, seated in the card's header band on the Goal stage.
  header?: ReactNode;
}) {
  const {
    recipe,
    seedIsCode,
    seedLanguage,
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
  } = w;

  const updatePart = (i: number, patch: { key?: string; value?: string }) =>
    setSeedParts(seedParts.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));

  // Splitting a whole text keeps it as the first part.
  const addPart = () => {
    if (seedMode === "parts") {
      setSeedParts([...seedParts, { key: "", value: "" }]);
      return;
    }
    const kept = seedText.trim()
      ? [{ key: "", value: seedText }]
      : seedParts.filter((p) => p.key.trim() || p.value.trim());
    setSeedParts([...kept, { key: "", value: "" }]);
    setSeedMode("parts");
  };

  const editorLanguage = seedLanguage ?? (recipe === "code" ? "Python" : "text");

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
  const seedHint =
    seedMode !== "text"
      ? undefined
      : interviewEligible
        ? msg("submit.blackbox.start.seed_hint_auto")
        : recipe === "code"
          ? seedPlaceholder
          : undefined;

  const showSeedTextarea = seedMode === "text" && !seedIsCode;
  // The stepper and status chip mean nothing until the agent has touched the
  // seed; idle they render empty and would leave a hollow label row.
  const showSeedAgent = interviewEligible && agent.signatureStatus !== "idle";

  const seedActions = (
    <div className="flex flex-wrap items-center gap-x-5">
      {seedMode === "none" ? (
        <SeedAction onClick={() => setSeedMode("text")}>
          <Plus className="size-3.5" />
          {msg("submit.blackbox.start.seed_add_action")}
        </SeedAction>
      ) : (
        <>
          <SeedAction onClick={addPart}>
            <Plus className="size-3.5" />
            {msg("submit.blackbox.start.add_part")}
          </SeedAction>
          {seedMode === "parts" && (
            <SeedAction onClick={() => setSeedMode("text")}>
              {msg("submit.blackbox.start.seed_whole_action")}
            </SeedAction>
          )}
          <SeedAction onClick={() => setSeedMode("none")}>
            {msg("submit.blackbox.start.seed_none_action")}
          </SeedAction>
        </>
      )}
    </div>
  );

  const seedFields = (
    <ExpandableTextarea
      id="bb-seed"
      label={seedLabel}
      value={seedText}
      onChange={(value) => {
        setSeedText(value);
        setSeedManuallyEdited(true);
      }}
      placeholder={seedPlaceholder}
      rows={8}
      className={`${TEXTAREA_CLASS} flex-1 font-mono text-sm`}
    >
      {({ textarea, trigger }) => (
        <Field
          label={seedLabel}
          tip="submit.blackbox.seed"
          htmlFor={showSeedTextarea ? "bb-seed" : undefined}
          hint={seedHint}
          trailing={
            showSeedTextarea || showSeedAgent ? (
              <>
                {showSeedTextarea && trigger}
                {showSeedAgent && (
                  <>
                    <VersionStepper agent={agent} artifact="signature" />
                    <ArtifactStatusChip status={agent.signatureStatus} />
                  </>
                )}
              </>
            ) : undefined
          }
          className="min-h-0 flex-1"
        >
          {seedMode === "text" &&
            (seedIsCode ? (
              <CodeEditor
                value={seedText}
                onChange={(v) => {
                  setSeedText(v);
                  setSeedManuallyEdited(true);
                }}
                height="420px"
                language={editorLanguage}
                label={seedLanguage ?? msg("submit.blackbox.start.seed_editor_label")}
                streaming={codeAssistMode === "auto" && agent.signatureStatus === "writing"}
                flashLines={codeAssistMode === "auto" ? agent.signatureFlashLines : undefined}
              />
            ) : (
              textarea
            ))}

          {seedMode === "parts" && (
            <div className="space-y-3">
              {seedParts.map((part, i) => (
                <ExpandableTextarea
                  key={i}
                  id={`bb-seed-part-${i}`}
                  label={part.key.trim() || seedLabel}
                  value={part.value}
                  onChange={(value) => updatePart(i, { value })}
                  placeholder={msg("submit.blackbox.start.part_value")}
                  rows={4}
                  className={`${TEXTAREA_CLASS} font-mono text-sm`}
                >
                  {({ textarea: partTextarea, trigger: partTrigger }) => (
                    <div className="space-y-2 rounded-lg border border-border/50 p-3">
                      <div className="flex items-center gap-2">
                        <Input
                          value={part.key}
                          onChange={(e) => updatePart(i, { key: e.target.value })}
                          placeholder={msg("submit.blackbox.start.part_key")}
                          className={`${MOBILE_INPUT_CLASS} font-mono`}
                        />
                        {partTrigger}
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
                      {partTextarea}
                    </div>
                  )}
                </ExpandableTextarea>
              ))}
            </div>
          )}

          {seedMode === "none" && (
            <p className="text-sm text-muted-foreground" dir="auto">
              {msg("submit.blackbox.start.seed_none_note")}
            </p>
          )}

          {seedActions}
        </Field>
      )}
    </ExpandableTextarea>
  );

  return (
    <BlackboxAuthoringShell
      w={w}
      start={header}
      title={msg("submit.blackbox.start.title")}
      description={msg("submit.blackbox.start.desc")}
    >
      {seedFields}
      <ExpandableTextarea
        id="bb-objective"
        label={msg("submit.blackbox.start.objective_label")}
        value={objective}
        onChange={setObjective}
        placeholder={msg("submit.blackbox.start.objective_placeholder")}
        rows={3}
        className={TEXTAREA_CLASS}
      >
        {({ textarea, trigger }) => (
          <Field
            label={msg("submit.blackbox.start.objective_label")}
            tip="submit.blackbox.objective"
            htmlFor="bb-objective"
            hint={interviewEligible ? msg("submit.blackbox.start.objective_hint_auto") : undefined}
            trailing={trigger}
          >
            {textarea}
          </Field>
        )}
      </ExpandableTextarea>
      <ExpandableTextarea
        id="bb-background"
        label={msg("submit.blackbox.start.background_label")}
        value={background}
        onChange={setBackground}
        placeholder={msg("submit.blackbox.start.background_placeholder")}
        rows={3}
        className={TEXTAREA_CLASS}
      >
        {({ textarea, trigger }) => (
          <Field
            label={msg("submit.blackbox.start.background_label")}
            htmlFor="bb-background"
            tip="submit.blackbox.background"
            trailing={trigger}
          >
            {textarea}
          </Field>
        )}
      </ExpandableTextarea>
    </BlackboxAuthoringShell>
  );
}
