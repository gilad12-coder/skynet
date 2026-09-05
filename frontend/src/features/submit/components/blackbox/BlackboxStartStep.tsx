"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Plus, Trash } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import { msg } from "@/shared/lib/messages";
import { tip } from "@/shared/lib/tooltips";

import type { BlackboxWizardContext } from "../../hooks/use-blackbox-wizard";
import { ArtifactStatusChip } from "../steps/AuthoringShell";
import { VersionStepper } from "../steps/CodeAgentPanel";
import { BlackboxAuthoringShell } from "./BlackboxAuthoringShell";
import { ExpandableTextarea } from "@/shared/ui/expandable-textarea";
import { Disclosure } from "../Disclosure";
import { Field, TEXTAREA_CLASS } from "./shared";

const CodeEditor = dynamic(() => import("@/shared/ui/code-editor").then((m) => m.CodeEditor), {
  ssr: false,
});

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

  const reducedMotion = useReducedMotion();
  const partIds = useRef(new WeakMap<object, number>());
  const nextPartId = useRef(0);
  const partKey = (part: object) => {
    let id = partIds.current.get(part);
    if (id == null) {
      id = nextPartId.current++;
      partIds.current.set(part, id);
    }
    return id;
  };

  const editSeed = (value: string) => {
    setSeedText(value);
    setSeedMode("text");
    setSeedManuallyEdited(true);
  };
  // Background is optional, so it folds away until it has something to say:
  // opening by itself when a clone, a draft or the interview's brief fills it.
  const [backgroundOpen, setBackgroundOpen] = useState(() => background.trim() !== "");
  useEffect(() => {
    if (background.trim()) setBackgroundOpen(true);
  }, [background]);

  const updatePart = (i: number, patch: { key?: string; value?: string }) =>
    setSeedParts(
      seedParts.map((part, index) => {
        if (index !== i) return part;
        const updated = { ...part, ...patch };
        partIds.current.set(updated, partKey(part));
        return updated;
      }),
    );

  const addPart = () => {
    const current =
      seedMode === "parts" ? seedParts : [{ key: "", value: seedMode === "none" ? "" : seedText }];
    setSeedParts([...current, { key: "", value: "" }]);
    setSeedMode("parts");
  };

  const removePart = (index: number) => {
    setSeedParts(seedParts.filter((_, i) => i !== index));
    setSeedManuallyEdited(true);
  };

  // Keep the outgoing card mounted until its collapse finishes.
  const finishRemoval = () => {
    if (seedParts.length === 1) {
      editSeed(seedParts[0]!.value);
      setSeedParts([]);
    }
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
    seedMode === "parts"
      ? undefined
      : interviewEligible
        ? msg("submit.blackbox.start.seed_hint_auto")
        : recipe === "code"
          ? seedPlaceholder
          : undefined;

  const showSeedTextarea = seedMode !== "parts" && !seedIsCode;
  // The stepper and status chip mean nothing until the agent has touched the
  // seed; idle they render empty and would leave a hollow label row.
  const showSeedAgent = interviewEligible && agent.signatureStatus !== "idle";

  const seedActions = (
    <div className="flex w-full flex-col gap-2">
      <Button
        type="button"
        variant="outline"
        onClick={addPart}
        className="min-h-11 w-full gap-2 rounded-lg border-dashed bg-transparent shadow-none"
      >
        <Plus className="size-4" aria-hidden="true" />
        {msg("submit.blackbox.start.add_part")}
      </Button>
    </div>
  );

  const seedFields = (
    <ExpandableTextarea
      id="bb-seed"
      label={seedLabel}
      value={seedMode === "none" ? "" : seedText}
      onChange={editSeed}
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
          {seedMode !== "parts" &&
            (seedIsCode ? (
              <CodeEditor
                value={seedMode === "none" ? "" : seedText}
                onChange={editSeed}
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
            <div>
              <AnimatePresence onExitComplete={finishRemoval}>
                {seedParts.map((part, i) => (
                  <motion.div
                    key={partKey(part)}
                    initial={reducedMotion ? false : { height: 0, opacity: 0, overflow: "hidden" }}
                    animate={{ height: "auto", opacity: 1, transitionEnd: { overflow: "visible" } }}
                    exit={{ height: 0, opacity: 0, overflow: "hidden", pointerEvents: "none" }}
                    transition={{ duration: reducedMotion ? 0 : 0.24, ease: [0.22, 1, 0.36, 1] }}
                  >
                    <div className={i > 0 ? "pt-3" : undefined}>
                      <ExpandableTextarea
                        id={`bb-seed-part-${partKey(part)}`}
                        label={
                          part.key.trim() || msg("submit.blackbox.start.part_label", { n: i + 1 })
                        }
                        value={part.value}
                        onChange={(value) => updatePart(i, { value })}
                        placeholder={msg("submit.blackbox.start.part_value")}
                        rows={4}
                        className={`${TEXTAREA_CLASS} min-h-32 rounded-none border-0 bg-transparent text-base shadow-none focus-visible:ring-inset md:text-sm`}
                      >
                        {({ textarea: partTextarea, trigger: partTrigger }) => (
                          <div className="overflow-hidden rounded-xl border border-border bg-background">
                            <div className="flex min-h-12 items-center gap-2 border-b border-border bg-muted/30 px-3">
                              <label
                                htmlFor={`bb-seed-part-${partKey(part)}`}
                                className="min-w-0 flex-1 truncate text-sm font-medium"
                                title={part.key || undefined}
                              >
                                {part.key.trim() ||
                                  msg("submit.blackbox.start.part_label", { n: i + 1 })}
                              </label>
                              {partTrigger}
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                aria-label={msg("submit.blackbox.start.remove_part")}
                                disabled={seedParts.length === 1}
                                onClick={() => removePart(i)}
                                className="size-11 shrink-0 text-muted-foreground hover:text-destructive"
                              >
                                <Trash className="size-4" />
                              </Button>
                            </div>
                            {partTextarea}
                          </div>
                        )}
                      </ExpandableTextarea>
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
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
          <Disclosure
            id="bb-background-panel"
            label={msg("submit.blackbox.start.background_toggle")}
            tip={tip("submit.blackbox.background")}
            open={backgroundOpen}
            onOpenChange={setBackgroundOpen}
            trailing={trigger}
          >
            {textarea}
          </Disclosure>
        )}
      </ExpandableTextarea>
    </BlackboxAuthoringShell>
  );
}
