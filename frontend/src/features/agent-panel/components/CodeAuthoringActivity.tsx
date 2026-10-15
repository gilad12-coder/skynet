"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { CheckCircle, PencilSimple, Trash } from "@/shared/ui/icons";
import { formatMsg, msg } from "@/shared/lib/messages";
import { getActiveIntlLocale } from "@/shared/lib/runtime-locale";

import { cn } from "@/shared/lib/utils";
import { diffHunks, diffStats, lineDiff } from "@/shared/lib/line-diff";
import type { ActivityKind, ActivityStatus } from "@/shared/lib/activity-summary";
import { InlineErrorRow } from "@/shared/ui/inline-error-row";
import { Skeleton } from "@/shared/ui/skeleton";
import { ActivityGroup, StepRow } from "@/shared/ui/agent/activity-steps";
import { ChatErrorBanner } from "@/shared/ui/agent/chat-error-banner";
import { ThinkingSection } from "@/shared/ui/agent/thinking-section";

import type { CodeAuthoringAgentState } from "../hooks/use-code-authoring-agent";
import {
  authoringToolRows,
  liveAuthoringView,
  outcomeAuthoringView,
  outcomeLine,
  type AuthoringCheck,
  type AuthoringEdit,
  type AuthoringOutcome,
  type AuthoringView,
} from "../lib/code-authoring";

// The same react-flow canvas the /submit wizard uses. Off the wizard it is the
// only place a workflow (multi-module) run's graph shows, so it stays inline.
const WorkflowCanvas = dynamic(
  () => import("@/features/submit/workflow/WorkflowCanvas").then((m) => m.WorkflowCanvas),
  { ssr: false, loading: () => <Skeleton height={420} borderRadius={8} /> },
);

const ADDED_TONE = "text-[#5A7247] dark:text-[#adc899]";

interface CodeAuthoringActivityProps {
  /** Lifted code-agent state, owned by the panel so it survives collapse. */
  agent: CodeAuthoringAgentState;
  /** When the tool call started; edits from earlier calls belong to their own rows. */
  since?: number;
}

/**
 * The coding tool in the generalist chat, as Codex shows a coding turn: the
 * thinking row, one row per edit ("Edited metric.py +12 −3") that opens to a
 * compact diff, one row per deleted file, and one row per ``verify_code`` call
 * (running, then passed or failed with each file's findings), in the order
 * they happened, under one summary line. The code itself is read and edited
 * in the wizard's Metric step, not here.
 */
export function CodeAuthoringActivity({ agent, since = 0 }: CodeAuthoringActivityProps) {
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

  // Before the seed starts there is nothing to mirror — show the neutral hint.
  // A finished call renders from its stored outcome instead, never this.
  if (!hasOutput) {
    return (
      <p className="py-1 text-[0.8125rem] text-muted-foreground">
        {msg("auto.features.submit.components.steps.codeagentpanel.literal.16")}
      </p>
    );
  }

  return (
    <div className="flex min-w-0 flex-col">
      <AuthoringRows view={liveAuthoringView(agent, since)} />
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

/**
 * A finished coding call, rendered from what it stored, so a reopened
 * conversation shows the rows the run ended with. A call from before outcomes
 * were stored shows one done row.
 */
export function CodeAuthoringOutcome({ outcome }: { outcome: AuthoringOutcome | null }) {
  if (!outcome) {
    return <StepRow icon={PencilSimple} label={msg("agent.coding_tool.past")} status="done" />;
  }
  return (
    <div className="flex min-w-0 flex-col">
      <AuthoringRows view={outcomeAuthoringView(outcome)} />
      {outcome.error && <InlineErrorRow message={outcome.error} className="mt-2 py-2" />}
    </div>
  );
}

/**
 * The closing line a finished run gets under its turn, after the turn's text.
 *
 * Args:
 *   outcome: The run's stored outcome.
 *
 * Returns:
 *   The sentence, or null when the run's rows already say how it ended.
 */
export function authoringOutcomeLine(outcome: AuthoringOutcome): string | null {
  const line = outcomeLine(outcome);
  if (!line) return null;
  if (line.key === "agent.coding_tool.outcome.stopped" || line.key === "agent.coding_tool.outcome.none") {
    return msg(line.key);
  }
  const files = new Intl.ListFormat(getActiveIntlLocale(), { type: "conjunction" }).format(line.files);
  return formatMsg(line.key, { files });
}

interface Step {
  key: string;
  kind: ActivityKind;
  status: ActivityStatus;
  row: React.ReactNode;
}

/** One of the coding agent's own tool calls, as its chat reports it. */
export interface CodingCall {
  id: string;
  tool: string;
  status: string;
  startedAt: number;
  path?: string;
  prevCode?: string;
  newCode?: string;
  verification?: { ok: boolean; files: ReadonlyArray<{ path: string; ok: boolean; errors: string[] }> };
}

/** The workspace file an edit call writes, or null for a call that edits no file. */
function editedFile(call: CodingCall): string | null {
  if (call.tool === "edit_run" || call.tool === "edit_signature" || call.tool === "edit_seed") return "run.py";
  if (call.tool === "edit_metric" || call.tool === "edit_scorer") return "metric.py";
  return call.tool === "write_file" ? (call.path ?? null) : null;
}

/**
 * One reply's tool calls from the coding agent's own chat, as the coding tool
 * lists them: each edit with its diff, each deleted file and each check, in
 * the order the agent made them.
 *
 * Args:
 *   calls: The reply's tool calls.
 */
export function CodingCallRows({ calls }: { calls: readonly CodingCall[] }) {
  const steps: Step[] = [];
  for (const call of calls) {
    const file = editedFile(call);
    if (file && call.newCode !== undefined) {
      steps.push({
        key: `edit-${call.id}`,
        kind: "edit",
        status: "done",
        row: <EditRow edit={{ file, before: call.prevCode ?? "", after: call.newCode, ts: call.startedAt }} />,
      });
    } else if (file && call.status === "running") {
      steps.push({
        key: `editing-${call.id}`,
        kind: "edit",
        status: "running",
        row: (
          <StepRow
            icon={PencilSimple}
            label={formatMsg("agent.coding_tool.editing", { file })}
            status="running"
          />
        ),
      });
    } else if (call.tool === "delete_file" || call.tool === "verify_code") {
      const { deletes, checks } = authoringToolRows([{ toolCalls: [call] }], 0);
      for (const deleted of deletes) {
        steps.push({
          key: `delete-${call.id}`,
          kind: "edit",
          status: "done",
          row: (
            <StepRow
              icon={Trash}
              label={formatMsg("agent.coding_tool.deleted", { file: deleted.file })}
              status="done"
            />
          ),
        });
      }
      for (const check of checks) steps.push(checkStep(check));
    }
  }
  if (steps.length === 0) return null;
  return (
    <ActivityGroup stayOpen steps={steps}>
      {steps.map((step) => (
        <React.Fragment key={step.key}>{step.row}</React.Fragment>
      ))}
    </ActivityGroup>
  );
}

/** The thinking row and the steps, in the order they happened, under their summary line. */
function AuthoringRows({ view }: { view: AuthoringView }) {
  const timed: Array<Step & { ts: number }> = [];
  for (const edit of view.edits) {
    timed.push({
      key: `edit-${edit.file}-${edit.ts}`,
      kind: "edit",
      status: "done",
      ts: edit.ts,
      row: <EditRow edit={edit} />,
    });
  }
  for (const deleted of view.deletes) {
    timed.push({
      key: `delete-${deleted.file}-${deleted.ts}`,
      kind: "edit",
      status: "done",
      ts: deleted.ts,
      row: (
        <StepRow
          icon={Trash}
          label={formatMsg("agent.coding_tool.deleted", { file: deleted.file })}
          status="done"
        />
      ),
    });
  }
  for (const check of view.checks) timed.push({ ...checkStep(check), ts: check.ts });
  const steps: Step[] = timed.sort((a, b) => a.ts - b.ts);
  for (const file of view.writing) {
    steps.push({
      key: `writing-${file}`,
      kind: "edit",
      status: "running",
      row: (
        <StepRow
          icon={PencilSimple}
          label={formatMsg("agent.coding_tool.editing", { file })}
          status="running"
        />
      ),
    });
  }

  return (
    <>
      {view.thinking && <ThinkingSection compact thinking={view.thinking} />}
      {steps.length > 0 && (
        // Finished rows stay as they ended; only the reader folds them.
        <ActivityGroup stayOpen steps={steps}>
          {steps.map((step) => (
            <React.Fragment key={step.key}>{step.row}</React.Fragment>
          ))}
        </ActivityGroup>
      )}
    </>
  );
}

/** One ``verify_code`` call: checking, then passed, or failed with each file's findings. */
function checkStep(check: AuthoringCheck): Step {
  const key = `verify-${check.id}-${check.ts}`;
  if (check.state === "running") {
    return {
      key,
      kind: "check",
      status: "running",
      row: (
        <StepRow icon={CheckCircle} label={msg("agent.coding_tool.check.checking")} status="running" />
      ),
    };
  }
  if (check.state === "passed") {
    return {
      key,
      kind: "check",
      status: "done",
      row: <StepRow icon={CheckCircle} label={msg("agent.coding_tool.check.passed")} status="done" />,
    };
  }
  const count = check.failures.reduce((sum, file) => sum + file.errors.length, 0);
  return {
    key,
    kind: "check",
    status: "error",
    row: (
      <StepRow
        icon={CheckCircle}
        label={msg("agent.coding_tool.check.failed")}
        detail={count > 0 && formatMsg("agent.coding_tool.check.errors", { count })}
        status="error"
      >
        {check.failures.map((file) => (
          <div key={file.path}>
            {file.path && (
              <p dir="ltr" className="font-mono text-foreground/85">
                {file.path}
              </p>
            )}
            <FailureList failures={file.errors} />
          </div>
        ))}
      </StepRow>
    ),
  };
}

/** One edit to a workspace file, opening to its diff. */
function EditRow({ edit }: { edit: AuthoringEdit }) {
  const lines = React.useMemo(() => lineDiff(edit.before, edit.after), [edit.before, edit.after]);
  const { added, removed } = diffStats(lines);
  return (
    <StepRow
      icon={PencilSimple}
      label={formatMsg("agent.coding_tool.edited", { file: edit.file })}
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
