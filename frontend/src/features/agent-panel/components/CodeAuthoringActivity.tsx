"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { CheckCircle, PencilSimple, WarningCircle } from "@/shared/ui/icons";
import { formatMsg, msg } from "@/shared/lib/messages";

import { cn } from "@/shared/lib/utils";
import { diffHunks, diffStats, lineDiff } from "@/shared/lib/line-diff";
import type { ActivityKind, ActivityStatus } from "@/shared/lib/activity-summary";
import { InlineErrorRow } from "@/shared/ui/inline-error-row";
import { Skeleton } from "@/shared/ui/skeleton";
import { ActivityGroup, StepRow } from "@/shared/ui/agent/activity-steps";
import { ChatErrorBanner } from "@/shared/ui/agent/chat-error-banner";
import { ThinkingSection } from "@/shared/ui/agent/thinking-section";

import {
  MAX_AUTHORING_FIXES,
  type CodeAuthoringAgentState,
} from "../hooks/use-code-authoring-agent";
import {
  authoringEdits,
  authoringThinking,
  type AuthoringEdit,
  type AuthoringFixAttempt,
} from "../lib/code-authoring";

// The same react-flow canvas the /submit wizard uses. Off the wizard it is the
// only place a workflow (multi-module) run's graph shows, so it stays inline.
const WorkflowCanvas = dynamic(
  () => import("@/features/submit/workflow/WorkflowCanvas").then((m) => m.WorkflowCanvas),
  { ssr: false, loading: () => <Skeleton height={420} borderRadius={8} /> },
);

const FILE_NAMES: Record<AuthoringEdit["file"], string> = {
  run: "run.py",
  metric: "metric.py",
};

const ADDED_TONE = "text-[#5A7247] dark:text-[#adc899]";

interface CodeAuthoringActivityProps {
  /** Lifted code-agent state, owned by the panel so it survives collapse. */
  agent: CodeAuthoringAgentState;
}

/**
 * The coding tool in the generalist chat, as Codex shows a coding turn: the
 * thinking row, one row per edit ("Edited metric.py +12 −3") that opens to a
 * compact diff, one row per failed check the agent fixed, and the current
 * check's verdict, all under one summary line. The code itself is read and
 * edited in the wizard's Metric step, not here.
 */
export function CodeAuthoringActivity({ agent }: CodeAuthoringActivityProps) {
  const streaming = agent.status === "streaming";
  const authored = agent.isWorkflow ? !!agent.workflowSpec : !!agent.signatureCode;
  const hasOutput = streaming || authored || !!agent.metricCode || !!agent.reasoning;
  const hasError = agent.status === "error" && !!agent.error;

  // A run that fails before emitting any reasoning or code — e.g. an upstream
  // rate-limit on the first token — would otherwise fall through to the neutral
  // hint below and swallow the reason. Surface the error itself so the user can
  // act (retry, or pick a different model in the composer).
  if (hasError && !hasOutput) {
    return <ChatErrorBanner message={agent.error} />;
  }

  // Before the seed starts (or on a reopened historical conversation where the
  // run state was cleared) there is nothing to mirror — show the neutral hint.
  if (!hasOutput) {
    return (
      <p className="py-1 text-[0.8125rem] text-muted-foreground">
        {msg("auto.features.submit.components.steps.codeagentpanel.literal.16")}
      </p>
    );
  }

  const thinking = authoringThinking(agent);
  const steps: Array<{ key: string; kind: ActivityKind; status: ActivityStatus; row: React.ReactNode }> =
    [];
  for (const edit of authoringEdits(agent.signatureVersions, agent.metricVersions)) {
    steps.push({
      key: `edit-${edit.file}-${edit.ts}`,
      kind: "edit",
      status: "done",
      row: <EditRow edit={edit} />,
    });
  }
  const writing = [
    !agent.isWorkflow && agent.signatureStatus === "writing" ? "run" : null,
    agent.metricStatus === "writing" ? "metric" : null,
  ].filter((file): file is AuthoringEdit["file"] => file !== null);
  for (const file of writing) {
    steps.push({
      key: `writing-${file}`,
      kind: "edit",
      status: "running",
      row: (
        <StepRow
          icon={PencilSimple}
          label={formatMsg("agent.coding_tool.editing", { file: FILE_NAMES[file] })}
          status="running"
        />
      ),
    });
  }
  if (!agent.isWorkflow) {
    for (const attempt of agent.fixAttempts) {
      steps.push({
        key: `fix-${attempt.attempt}`,
        kind: "check",
        status: attempt.fix === null ? "running" : "done",
        row: <FixRow attempt={attempt} />,
      });
    }
    const check = checkStep(agent);
    if (check) steps.push(check);
  }

  return (
    <div className="flex min-w-0 flex-col">
      {thinking && <ThinkingSection compact thinking={thinking} />}
      {steps.length > 0 && (
        <ActivityGroup live={streaming} steps={steps}>
          {steps.map((step) => (
            <React.Fragment key={step.key}>{step.row}</React.Fragment>
          ))}
        </ActivityGroup>
      )}
      {agent.isWorkflow && !agent.sharedWithWizard && agent.workflowSpec && (
        <div
          dir="ltr"
          className="mt-2 h-[min(440px,60dvh)] overflow-hidden rounded-lg border border-border/40 sm:h-[440px]"
        >
          <WorkflowCanvas
            spec={agent.workflowSpec}
            specRevision={agent.workflowRevision}
            onSpecChange={agent.updateWorkflowSpec}
            pulseNodeId={agent.agentPulseNodeId}
          />
        </div>
      )}
      {agent.error && <InlineErrorRow message={agent.error} className="mt-2 py-2" />}
    </div>
  );
}

/** The validity check's verdict on the current code, as the last step. */
function checkStep(
  agent: CodeAuthoringAgentState,
): { key: string; kind: ActivityKind; status: ActivityStatus; row: React.ReactNode } | null {
  if (agent.checkStatus === "idle") return null;
  if (agent.checkStatus === "checking") {
    return {
      key: "check",
      kind: "check",
      status: "running",
      row: (
        <StepRow icon={CheckCircle} label={msg("agent.coding_tool.check.checking")} status="running" />
      ),
    };
  }
  if (agent.checkStatus === "passed") {
    return {
      key: "check",
      kind: "check",
      status: "done",
      row: <StepRow icon={CheckCircle} label={msg("agent.coding_tool.check.passed")} status="done" />,
    };
  }
  const errors = [
    ...(agent.signatureValidation?.errors ?? []),
    ...(agent.metricValidation?.errors ?? []),
  ];
  return {
    key: "check",
    kind: "check",
    status: "error",
    row: (
      <StepRow
        icon={CheckCircle}
        label={msg("agent.coding_tool.check.failed")}
        detail={
          errors.length > 0 && formatMsg("agent.coding_tool.check.errors", { count: errors.length })
        }
        status="error"
      >
        {errors.length > 0 && <FailureList failures={errors} />}
      </StepRow>
    ),
  };
}

/** One edit to the run code or the metric, opening to its diff. */
function EditRow({ edit }: { edit: AuthoringEdit }) {
  const lines = React.useMemo(() => lineDiff(edit.before, edit.after), [edit.before, edit.after]);
  const { added, removed } = diffStats(lines);
  return (
    <StepRow
      icon={PencilSimple}
      label={formatMsg("agent.coding_tool.edited", { file: FILE_NAMES[edit.file] })}
      detail={
        <span dir="ltr" className="font-mono tabular-nums">
          <span className={ADDED_TONE}>+{added}</span>{" "}
          <span className="text-destructive">−{removed}</span>
        </span>
      }
      status="done"
    >
      <CompactDiff lines={lines} />
    </StepRow>
  );
}

/** The changed lines of an edit with a little context, as a unified diff. */
function CompactDiff({ lines }: { lines: ReturnType<typeof lineDiff> }) {
  const hunks = React.useMemo(() => diffHunks(lines), [lines]);
  return (
    <pre
      dir="ltr"
      className="max-h-64 overflow-auto font-mono text-[0.6875rem]/[1.55] text-foreground/85"
    >
      {hunks.map((line, i) =>
        line.type === "gap" ? (
          <div key={i} className="select-none text-muted-foreground/70">
            {"⋯ "}
            {formatMsg("optimization.blackbox.repo.browser.folded_lines", { count: line.count })}
          </div>
        ) : (
          <div
            key={i}
            className={cn(
              "whitespace-pre-wrap break-words",
              line.type === "add" && cn("bg-[#5A7247]/10", ADDED_TONE),
              line.type === "del" && "bg-destructive/10 text-destructive",
            )}
          >
            <span className="select-none opacity-60">
              {line.type === "add" ? "+ " : line.type === "del" ? "− " : "  "}
            </span>
            {line.text}
          </div>
        ),
      )}
    </pre>
  );
}

/**
 * A failed check that went back to the agent: what it flagged, and what the
 * agent replied and changed.
 */
function FixRow({ attempt }: { attempt: AuthoringFixAttempt }) {
  const changed = [
    attempt.fix?.runChanged ? FILE_NAMES.run : null,
    attempt.fix?.metricChanged ? FILE_NAMES.metric : null,
  ].filter((label): label is string => label !== null);
  return (
    <StepRow
      icon={WarningCircle}
      label={msg("agent.coding_tool.check.failed")}
      detail={formatMsg("agent.coding_tool.fix.attempt", {
        p1: attempt.attempt,
        p2: MAX_AUTHORING_FIXES,
      })}
      status={attempt.fix === null ? "running" : "done"}
    >
      <div>
        <p>{msg("agent.coding_tool.fix.failed")}</p>
        <FailureList failures={attempt.failures} />
      </div>
      <div>
        <p>{msg("agent.coding_tool.fix.fix")}</p>
        {attempt.fix === null ? (
          <p className="agent-shimmer-text">{msg("agent.coding_tool.fix.writing")}</p>
        ) : (
          <>
            {attempt.fix.reply && (
              <p dir="auto" className="line-clamp-4 whitespace-pre-line text-foreground/85">
                {attempt.fix.reply}
              </p>
            )}
            <p>
              {changed.length > 0
                ? formatMsg("agent.coding_tool.fix.changed", { p1: changed.join(", ") })
                : msg("agent.coding_tool.fix.unchanged")}
            </p>
          </>
        )}
      </div>
    </StepRow>
  );
}

function FailureList({ failures }: { failures: readonly string[] }) {
  return (
    <ul className="list-disc space-y-0.5 ps-4 text-destructive">
      {failures.map((failure, i) => (
        <li key={i} dir="auto" className="break-words">
          {failure}
        </li>
      ))}
    </ul>
  );
}
