"use client";

import * as React from "react";
import { CheckCircle, PencilSimple, Trash } from "@/shared/ui/icons";
import { formatMsg, msg } from "@/shared/lib/messages";

import { cn } from "@/shared/lib/utils";
import { diffHunks, diffStats, lineDiff } from "@/shared/lib/line-diff";
import type { ActivityKind, ActivityStatus } from "@/shared/lib/activity-summary";
import { ActivityGroup, StepRow } from "@/shared/ui/agent/activity-steps";

import { authoringToolRows, type AuthoringCheck, type AuthoringEdit } from "../lib/code-authoring";

const ADDED_TONE = "text-[#5A7247] dark:text-[#adc899]";

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
