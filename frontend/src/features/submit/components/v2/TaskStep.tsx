"use client";

import * as React from "react";

import { ArrowCounterClockwise } from "@/shared/ui/icons";
import {
  AgentThread,
  ChatTranscript,
  Composer,
  ComposerModelMenu,
  QuestionChoices,
} from "@/shared/ui/agent";
import { useSteerQueue } from "@/shared/ui/agent/use-steer-queue";
import { ExpandableTextarea } from "@/shared/ui/expandable-textarea";
import { LoadingState } from "@/shared/ui/loading-state";
import { Button } from "@/shared/ui/primitives/button";
import { Label } from "@/shared/ui/primitives/label";
import { TEXTAREA_SURFACE_CLASS } from "@/shared/ui/primitives/textarea";
import { RetryIconButton } from "@/shared/ui/retry-icon-button";
import { msg } from "@/shared/lib/messages";
import { cn } from "@/shared/lib/utils";

import { useTaskInterview, type TaskInterviewState } from "../../hooks/use-task-interview";
import { useWizardV2 } from "../../hooks/use-unified-wizard";
import { taskIssue } from "../../lib/wizard-v2";
import { AuthoringShell } from "../steps/AuthoringShell";
import { ArtifactConfirmCard, v2Msg } from "./ArtifactConfirmCard";
import { WizardScreen } from "./WizardScreen";

/**
 * Step 1, Task + Artifact: the interview in the side panel writes the
 * objective, background, artifact kind and starting version; the main pane
 * shows them editable, and Continue moves on. Screen 0 holds the
 * objective and background, screen 1 the artifact.
 */
export function TaskStep({ page }: { page: number }) {
  const ctx = useWizardV2();
  const { state, guided } = ctx;
  const task = state.task;
  const t = (key: string) => v2Msg(key, guided);

  // Manual hides the interview; it never discards the transcript.
  const [assist, setAssist] = React.useState<"auto" | "manual">("auto");
  const interview = useTaskInterview(ctx, assist === "auto");

  return (
    <AuthoringShell
      value={assist}
      onChange={setAssist}
      title={t("submit.v2.task.title")}
      description={t("submit.v2.task.desc")}
      sidePanel={
        <TaskInterviewPanel interview={interview} guided={guided} className="absolute inset-0" />
      }
    >
      <WizardScreen
        active={page === 0}
        className="relative flex flex-col gap-5 px-4 py-5 sm:px-6 sm:py-6"
      >
        <TaskField
          id="v2-objective"
          label={t("submit.v2.task.objective_label")}
          hint={assist === "auto" ? t("submit.v2.task.objective_hint_auto") : undefined}
          placeholder={t("submit.v2.task.objective_placeholder")}
          value={task.objective}
          onChange={(v) => interview.editField("objective", v)}
          rows={3}
        />
        <TaskField
          id="v2-background"
          label={t("submit.v2.task.background_label")}
          placeholder={t("submit.v2.task.background_placeholder")}
          value={task.background}
          onChange={(v) => interview.editField("background", v)}
          rows={4}
        />
      </WizardScreen>
      <WizardScreen active={page === 1} className="relative px-4 py-5 sm:px-6 sm:py-6">
        <ArtifactConfirmCard
          kind={task.artifactKind}
          onKindChange={(k) => interview.editField("artifactKind", k)}
          startingVersion={task.startingVersion}
          onStartingVersionChange={(v) => interview.editField("startingVersion", v)}
          rationale={task.artifactRationale}
          issue={taskIssue(task)}
          writing={interview.busy}
          guided={guided}
        />
      </WizardScreen>
    </AuthoringShell>
  );
}

function TaskField({
  id,
  label,
  hint,
  placeholder,
  value,
  onChange,
  rows,
}: {
  id: string;
  label: string;
  hint?: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  rows: number;
}) {
  return (
    <ExpandableTextarea
      id={id}
      label={label}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      rows={rows}
      className={TEXTAREA_SURFACE_CLASS}
    >
      {({ textarea, trigger }) => (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor={id}>{label}</Label>
            {trigger}
          </div>
          {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
          {textarea}
        </div>
      )}
    </ExpandableTextarea>
  );
}

/**
 * The task interview chat: streamed replies, collapsible thinking, one-click
 * answer choices, stop, and edit-and-resend on any earlier answer.
 */
function TaskInterviewPanel({
  interview,
  guided,
  className,
}: {
  interview: TaskInterviewState;
  guided: boolean;
  className?: string;
}) {
  const [draft, setDraft] = React.useState("");
  const t = (key: string) => v2Msg(key, guided);
  const unanswered =
    !interview.busy &&
    interview.messages.length > 0 &&
    interview.messages[interview.messages.length - 1]?.role === "user";

  const submit = () => {
    const content = draft.trim();
    if (!content || interview.busy) return;
    setDraft("");
    interview.send(content);
  };

  // Answers typed while the interviewer is replying wait for it to finish.
  const { midTurn } = useSteerQueue({ busy: interview.busy, send: interview.send });

  return (
    <div className={cn("flex h-full min-h-0 flex-col overflow-hidden", className)}>
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border/40 px-4 py-3">
        <h3 className="text-sm font-semibold text-foreground">{t("submit.v2.task.chat.title")}</h3>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={interview.restart}
          disabled={interview.busy || interview.messages.length === 0}
          aria-label={msg("submit.code.interview.restart")}
        >
          <ArrowCounterClockwise className="size-3.5" />
        </Button>
      </div>

      <AgentThread
        scrollDeps={[
          interview.messages.length,
          interview.streamText,
          interview.thinking?.reasoning,
        ]}
        isEmpty={interview.messages.length === 0}
        emptyState={
          interview.error ? null : (
            <LoadingState label={t("submit.v2.task.chat.reading")} className="h-full py-0" />
          )
        }
      >
        <ChatTranscript
          messages={interview.messages}
          streaming={interview.busy}
          editAndResend={interview.editAndResend}
          thinking={interview.thinking ?? undefined}
          animatePairs
        />
      </AgentThread>

      {(interview.error || unanswered) && (
        <div className="flex items-center justify-between gap-3 border-t border-border/40 px-4 py-2.5">
          <p role={interview.error ? "alert" : undefined} className="text-xs text-destructive">
            {interview.error
              ? msg("submit.code.interview.error")
              : t("submit.v2.task.chat.stopped")}
          </p>
          <RetryIconButton label={msg("submit.code.interview.retry")} onClick={interview.retry} />
        </div>
      )}

      {interview.done && !interview.busy && !interview.error && (
        <p className="border-t border-border/40 px-4 py-2.5 text-xs text-muted-foreground">
          {t("submit.v2.task.chat.done")}
        </p>
      )}

      {!interview.error && interview.options.length > 0 && !interview.busy && (
        <QuestionChoices
          options={interview.options.map((o) => ({
            label: o.label,
            description: o.description ?? "",
          }))}
          onSelect={interview.send}
          hint={msg("submit.code.interview.choices_hint")}
          ariaLabel={msg("submit.code.interview.choices_label")}
        />
      )}

      <Composer
        value={draft}
        onChange={setDraft}
        onSubmit={submit}
        onStop={interview.stop}
        streaming={interview.busy}
        midTurn={midTurn}
        placeholder={t("submit.v2.task.chat.placeholder")}
        modelMenu={
          <ComposerModelMenu
            value={interview.model}
            onChange={interview.setModel}
            effort={interview.reasoningEffort}
            onEffortChange={interview.setReasoningEffort}
            defaultFlag="is_interview_default"
          />
        }
      />
    </div>
  );
}
