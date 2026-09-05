"use client";

import { useEffect, useState } from "react";

import { Input } from "@/shared/ui/primitives/input";
import { cn } from "@/shared/lib/utils";
import { tip } from "@/shared/lib/tooltips";
import { TERMS } from "@/shared/lib/terms";
import { formatMsg, msg } from "@/shared/lib/messages";
import { ExpandableTextarea } from "@/shared/ui/expandable-textarea";

import type { BlackboxWizardContext } from "../../hooks/use-blackbox-wizard";
import { Disclosure } from "../Disclosure";
import { Field, MOBILE_INPUT_CLASS, Segmented, StepCard, TEXTAREA_CLASS } from "./shared";

export function BlackboxBasicsStep({ w }: { w: BlackboxWizardContext }) {
  const {
    jobName,
    setJobName,
    jobDescription,
    setJobDescription,
    isPrivate,
    setIsPrivate,
    suggestedName,
  } = w;
  // The description is optional, so it stays folded until it holds text.
  const [descriptionOpen, setDescriptionOpen] = useState(() => jobDescription.trim() !== "");
  useEffect(() => {
    if (jobDescription.trim()) setDescriptionOpen(true);
  }, [jobDescription]);

  return (
    <StepCard
      title={msg("auto.features.submit.components.steps.basicsstep.1")}
      description={
        <>
          {msg("auto.features.submit.components.steps.basicsstep.2")}
          {TERMS.optimization}
        </>
      }
      tutorial="wizard-step-1"
    >
      <Field
        label={
          <>
            {msg("auto.features.submit.components.steps.basicsstep.3")}
            {TERMS.optimization}
          </>
        }
        htmlFor="bb-job-name"
        tip="submit.name"
        hint={suggestedName ? msg("submit.blackbox.basics.name_suggested_hint") : undefined}
      >
        <Input
          id="bb-job-name"
          placeholder={
            suggestedName || msg("auto.features.submit.components.steps.basicsstep.literal.1")
          }
          value={jobName}
          onChange={(e) => setJobName(e.target.value)}
          className={MOBILE_INPUT_CLASS}
        />
      </Field>
      <ExpandableTextarea
        id="bb-job-description"
        label={msg("auto.features.submit.components.steps.basicsstep.4")}
        value={jobDescription}
        onChange={(value) => {
          if (value.length <= 280) setJobDescription(value);
        }}
        placeholder={formatMsg("auto.features.submit.components.steps.basicsstep.template.1", {
          p1: TERMS.optimization,
        })}
        rows={3}
        className={TEXTAREA_CLASS}
      >
        {({ textarea, trigger }) => (
          <Disclosure
            id="bb-job-description-panel"
            label={msg("auto.features.submit.components.steps.basicsstep.4")}
            tip={tip("submit.description")}
            open={descriptionOpen}
            onOpenChange={setDescriptionOpen}
            trailing={
              <>
                <span
                  className={cn(
                    "text-[0.625rem] tabular-nums transition-colors",
                    jobDescription.length > 280
                      ? "text-destructive font-medium"
                      : "text-muted-foreground/50",
                  )}
                >
                  {jobDescription.length}
                  {msg("auto.features.submit.components.steps.basicsstep.5")}
                </span>
                {trigger}
              </>
            }
          >
            {textarea}
          </Disclosure>
        )}
      </ExpandableTextarea>
      <Field label={msg("submit.basics.privacy.label")} tip="submit.privacy">
        <Segmented
          label={msg("submit.basics.privacy.label")}
          value={isPrivate ? "private" : "public"}
          onChange={(v) => setIsPrivate(v === "private")}
          options={[
            {
              value: "private",
              label: msg("submit.basics.privacy.private"),
              desc: msg("submit.basics.privacy.private_desc"),
            },
            {
              value: "public",
              label: msg("submit.basics.privacy.public"),
              desc: msg("submit.basics.privacy.public_desc"),
            },
          ]}
        />
      </Field>
    </StepCard>
  );
}
