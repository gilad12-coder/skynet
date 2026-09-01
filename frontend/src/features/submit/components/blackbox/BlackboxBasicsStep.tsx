"use client";

import { Input } from "@/shared/ui/primitives/input";
import { Label } from "@/shared/ui/primitives/label";
import { HelpTip } from "@/shared/ui/help-tip";
import { cn } from "@/shared/lib/utils";
import { tip } from "@/shared/lib/tooltips";
import { TERMS } from "@/shared/lib/terms";
import { formatMsg, msg } from "@/shared/lib/messages";

import type { BlackboxWizardContext } from "../../hooks/use-blackbox-wizard";
import { Field, MOBILE_INPUT_CLASS, Segmented, StepCard, TEXTAREA_CLASS } from "./shared";

export function BlackboxBasicsStep({ w }: { w: BlackboxWizardContext }) {
  const { jobName, setJobName, jobDescription, setJobDescription, isPrivate, setIsPrivate } = w;

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
        tip="submit.name"
      >
        <Input
          placeholder={msg("auto.features.submit.components.steps.basicsstep.literal.1")}
          value={jobName}
          onChange={(e) => setJobName(e.target.value)}
          className={MOBILE_INPUT_CLASS}
        />
      </Field>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>
            <HelpTip text={tip("submit.description")}>
              {msg("auto.features.submit.components.steps.basicsstep.4")}
            </HelpTip>
          </Label>
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
        </div>
        <textarea
          value={jobDescription}
          onChange={(e) => {
            if (e.target.value.length <= 280) setJobDescription(e.target.value);
          }}
          placeholder={formatMsg("auto.features.submit.components.steps.basicsstep.template.1", {
            p1: TERMS.optimization,
          })}
          rows={3}
          className={TEXTAREA_CLASS}
        />
      </div>
      <Field label={msg("submit.basics.privacy.label")} tip="submit.privacy">
        <Segmented
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
