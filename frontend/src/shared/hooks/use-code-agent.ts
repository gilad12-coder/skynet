"use client";

import * as React from "react";
import { useCompletionNotification } from "@/shared/hooks/use-completion-notification";
import { toast } from "react-toastify";
import { formatMsg, msg } from "@/shared/lib/messages";

import {
  streamCodeAgent,
  type AgentQuestion,
  type BlackboxAuthoringContext,
  type CodeAgentToolName,
} from "@/shared/lib/api";
import { getActiveLocale } from "@/shared/lib/runtime-locale";
import { TERMS } from "@/shared/lib/terms";
import type { ParsedDataset } from "@/shared/lib/parse-dataset";
import type { ValidateCodeResponse, WorkflowSpec } from "@/shared/types/api";
import type { TurnStats } from "@/shared/ui/agent/types";

type AgentStatus = "idle" | "streaming" | "done" | "error";
type AgentMode = "seed" | "chat";
export type ArtifactStatus = "idle" | "waiting" | "writing" | "done";

type AgentToolName = CodeAgentToolName;
type AgentToolStatus = "running" | "done" | "error";

// Black-box runs drive the same two editor slots under their own tool names.
function isSeedTool(tool: AgentToolName): boolean {
  return tool === "edit_signature" || tool === "edit_seed";
}

function isScorerTool(tool: AgentToolName): boolean {
  return tool === "edit_metric" || tool === "edit_scorer";
}

function isRepoTool(tool: AgentToolName): boolean {
  return tool === "list_repo_folder" || tool === "read_repo_file";
}

export interface AgentToolCall {
  id: string;
  tool: AgentToolName;
  reason: string;
  status: AgentToolStatus;
  startedAt: number;
  endedAt: number | null;
  prevCode?: string;
  newCode?: string;
}

// Per-index line diff — returns 1-based line numbers in `next` that differ
// from `prev`. Good enough for flashing small refinements; if the agent
// restructures heavily, most lines will flash (acceptable).
function diffChangedLines(prev: string, next: string): number[] {
  if (!prev.trim()) return [];
  const prevLines = prev.split("\n");
  const nextLines = next.split("\n");
  const changed: number[] = [];
  for (let i = 0; i < nextLines.length; i++) {
    if (nextLines[i] !== prevLines[i]) changed.push(i + 1);
  }
  return changed;
}

// Compact the backend ValidateCodeResponse into a short string the agent can
// read on the next turn — gives it concrete "what's broken" context so the
// retry is targeted, not another blind rewrite.
function summarizeValidation(v: ValidateCodeResponse | null): string {
  if (!v) return "";
  if (v.valid && v.warnings.length === 0) return "OK";
  const parts: string[] = [];
  if (v.errors.length > 0) parts.push(`errors: ${v.errors.join(" | ")}`);
  if (v.warnings.length > 0) parts.push(`warnings: ${v.warnings.join(" | ")}`);
  return parts.join("; ");
}

const MAX_AUTO_FIX = 2;

// Synthetic opener shown as a user bubble before the seed reply. It gives
// the conversation a natural starting point — the AI's first message reads
// as a response to a real request, not a monologue — and lets the user
// revise it via the edit pencil to steer the initial generation. Resolved on
// call (not at module scope) so it can't capture a raw key before the message
// shim has loaded.
function seedUserMessage(blackbox: boolean): string {
  if (blackbox) return msg("submit.blackbox.agent.seed_request");
  return formatMsg("auto.features.submit.hooks.use.code.agent.template.1", {
    p1: TERMS.dataset,
  });
}

// Seed mode runs two authors (signature+metric, or graph+metric) in parallel
// over one multiplexed SSE stream. Keyed buffers keep each stream's reasoning
// contiguous; multi-stream runs render as labeled sections instead of
// token-interleaved gibberish.
interface ReasoningSections {
  order: string[];
  bufs: Record<string, string>;
}

function reasoningSourceLabel(source: string): string {
  if (source === "signature") return TERMS.signature;
  if (source === "metric") return TERMS.metric;
  // Module names are technical terms kept in English throughout the UI.
  if (source === "workflow") return "Workflow";
  return source;
}

function composeReasoning(sections: ReasoningSections): string {
  const first = sections.order[0];
  if (first === undefined) return "";
  if (sections.order.length === 1) return sections.bufs[first] ?? "";
  return sections.order
    .map((key) => `[${reasoningSourceLabel(key)}]\n${sections.bufs[key] ?? ""}`)
    .join("\n\n");
}

interface AgentMessage {
  role: "assistant" | "user";
  content: string;
  toolCalls?: AgentToolCall[];
  model?: string | null;
  /** Concrete model selected by Auto Router, when the route was automatic. */
  servedModel?: string | null;
  stats?: TurnStats | null;
}

interface ArtifactVersion {
  code: string;
  ts: number;
}

export interface CodeAgentState {
  status: AgentStatus;
  mode: AgentMode;
  statusLabel: string;
  signatureStatus: ArtifactStatus;
  metricStatus: ArtifactStatus;
  messages: AgentMessage[];
  error: string | null;
  /** The black-box wizard agent's daily turn cap is used up. */
  limitReached: boolean;
  /** The repository the agent is reading to open the conversation by
   *  itself, until its first words arrive; `null` otherwise. */
  openingRepo: string | null;
  canSend: boolean;
  /** The question the agent's last reply asked, with clickable answers. */
  question: AgentQuestion | null;
  signatureVersions: ArtifactVersion[];
  metricVersions: ArtifactVersion[];
  signatureVersionIndex: number;
  metricVersionIndex: number;
  signatureFlashLines: number[];
  metricFlashLines: number[];
  reasoning: string;
  reasoningStartedAt: number | null;
  reasoningEndedAt: number | null;
  goToSignatureVersion: (index: number) => void;
  goToMetricVersion: (index: number) => void;
  send: (message: string) => void;
  editAndResend: (messageIndex: number, content: string) => void;
  retry: () => void;
  fallbackToManual: () => void;
  stop: () => void;
  reset: () => void;
}

export interface UseCodeAgentArgs {
  codeAssistMode: "auto" | "manual";
  setCodeAssistMode: (m: "auto" | "manual") => void;
  // Plain string roles (input/output/ignore); this hook only reads the
  // "input"/"output" roles.
  columnRoles: Record<string, string>;
  columnKinds: Record<string, "text" | "image">;
  parsedDataset: ParsedDataset | null;
  moduleName: string;
  signatureCode: string;
  metricCode: string;
  setSignatureCode: (v: string) => void;
  setMetricCode: (v: string) => void;
  signatureManuallyEdited: boolean;
  metricManuallyEdited: boolean;
  setSignatureManuallyEdited: (v: boolean) => void;
  setMetricManuallyEdited: (v: boolean) => void;
  setSignatureValidation: (v: ValidateCodeResponse | null) => void;
  setMetricValidation: (v: ValidateCodeResponse | null) => void;
  signatureValidation: ValidateCodeResponse | null;
  metricValidation: ValidateCodeResponse | null;
  runSignatureValidation: (overrideCode?: string) => Promise<unknown>;
  runMetricValidation: (overrideCode?: string) => Promise<unknown>;
  // Workflow mode (module_name === "workflow"): the agent authors the graph
  // instead of a single signature. `workflowTouched` guards the auto-seed
  // like the manual-edit flags do for code; `applyAgentWorkflow` lands a
  // graph snapshot on the canvas (with the changed node pulsed).
  isWorkflow?: boolean;
  workflowSpec?: WorkflowSpec | null;
  workflowTouched?: boolean;
  applyAgentWorkflow?: (spec: WorkflowSpec, changedNodeId: string | null) => void;
  // Gates the auto-seed while the wizard's module picker is still open; the
  // seed fires as soon as this flips true (i.e. the user picked a module).
  seedEnabled?: boolean;
  // Directives confirmed at the end of the Signature & Metric interview;
  // the seed authors honor them. Empty when the interview was skipped.
  interviewBrief?: string[];
  /** Black-box authoring context; when set the agent drafts the starting
   *  point + Python scorer and no dataset is required. */
  blackbox?: BlackboxAuthoringContext | null;
  /** Black-box chat: lands objective / background text the agent wrote. */
  onBrief?: (fields: { objective?: string; background?: string }) => void;
  // Catalog model id + effort the code author runs on (the composer's model
  // menu). Absent/`null` routes automatically. The agent panel forwards the
  // conversation's chosen model so code authoring follows the composer.
  model?: string | null;
  reasoningEffort?: string | null;
  /** Black-box repository: once per picked repository/branch the agent
   *  reads it and opens the conversation without the user typing. */
  kickoffEnabled?: boolean;
}

const DAILY_LIMIT_CODE = "wizard_agent.daily_limit_reached";
// Picking a repository resets its branch and the branch picker may then fill
// one in; waiting for the selection to settle starts one opening, not two.
const KICKOFF_SETTLE_MS = 600;

export function useCodeAgent(args: UseCodeAgentArgs): CodeAgentState {
  const {
    codeAssistMode,
    setCodeAssistMode,
    columnRoles,
    columnKinds,
    parsedDataset,
    moduleName,
    signatureCode,
    metricCode,
    setSignatureCode,
    setMetricCode,
    signatureManuallyEdited,
    metricManuallyEdited,
    setSignatureManuallyEdited,
    setMetricManuallyEdited,
    setSignatureValidation,
    setMetricValidation,
    signatureValidation,
    metricValidation,
    runSignatureValidation,
    runMetricValidation,
    isWorkflow = false,
    workflowSpec = null,
    workflowTouched = false,
    applyAgentWorkflow,
    seedEnabled = true,
    interviewBrief,
    model,
    reasoningEffort,
    blackbox = null,
    onBrief,
    kickoffEnabled = false,
  } = args;

  const [status, setStatus] = React.useState<AgentStatus>("idle");
  // The run notifies from the hook, so it still does after its panel has left the screen.
  useCompletionNotification(status === "streaming", () =>
    msg(status === "error" ? "notify.code.failed" : "notify.code.done"),
  );
  const [mode, setMode] = React.useState<AgentMode>("seed");
  const [statusLabel, setStatusLabel] = React.useState("");
  const [signatureStatus, setSignatureStatus] = React.useState<ArtifactStatus>("idle");
  const [metricStatus, setMetricStatus] = React.useState<ArtifactStatus>("idle");
  const [messages, setMessages] = React.useState<AgentMessage[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [limitReached, setLimitReached] = React.useState(false);
  // The current run is an opening (no user message to retry from).
  const [openingRun, setOpeningRun] = React.useState(false);
  const [kickedKey, setKickedKey] = React.useState<string | null>(null);
  const [question, setQuestion] = React.useState<AgentQuestion | null>(null);
  const [signatureVersions, setSignatureVersions] = React.useState<ArtifactVersion[]>([]);
  const [metricVersions, setMetricVersions] = React.useState<ArtifactVersion[]>([]);
  const [signatureVersionIndex, setSignatureVersionIndex] = React.useState(-1);
  const [metricVersionIndex, setMetricVersionIndex] = React.useState(-1);
  const [signatureFlashLines, setSignatureFlashLines] = React.useState<number[]>([]);
  const [metricFlashLines, setMetricFlashLines] = React.useState<number[]>([]);
  const [reasoning, setReasoning] = React.useState("");
  const [reasoningStartedAt, setReasoningStartedAt] = React.useState<number | null>(null);
  const [reasoningEndedAt, setReasoningEndedAt] = React.useState<number | null>(null);

  const abortRef = React.useRef<AbortController | null>(null);
  const sigBufRef = React.useRef("");
  const metricBufRef = React.useRef("");
  const replyBufRef = React.useRef("");
  const reasoningBufRef = React.useRef("");
  const reasoningSectionsRef = React.useRef<ReasoningSections>({ order: [], bufs: {} });
  // Latches once per run: the timer stops the moment the model moves from
  // reasoning to producing artifacts, even if a parallel stream reasons on.
  const reasoningEndedRef = React.useRef(false);
  const autoRanRef = React.useRef(false);
  const [sessionKey, setSessionKey] = React.useState(0);
  const pendingValidationsRef = React.useRef<
    Array<{ kind: "signature" | "metric"; promise: Promise<unknown> }>
  >([]);
  const autoFixAttemptsRef = React.useRef(0);
  const runAgentRef = React.useRef<
    ((msg: string, hist: AgentMessage[], kickoff?: boolean) => void) | null
  >(null);
  const messagesRef = React.useRef<AgentMessage[]>([]);
  const flashClearRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Latest values for the stream callbacks — kept in a ref so closures
  // created inside `runAgent` stay in sync without re-creating the callback.
  const snapshotRef = React.useRef({
    signatureCode,
    metricCode,
    signatureValidation,
    metricValidation,
    workflowSpec,
  });
  React.useEffect(() => {
    snapshotRef.current = {
      signatureCode,
      metricCode,
      signatureValidation,
      metricValidation,
      workflowSpec,
    };
  }, [signatureCode, metricCode, signatureValidation, metricValidation, workflowSpec]);

  // Revert support across the conversation (first graph ever seen).
  const initialWorkflowRef = React.useRef<WorkflowSpec | null>(null);
  const applyAgentWorkflowRef = React.useRef(applyAgentWorkflow);
  React.useEffect(() => {
    applyAgentWorkflowRef.current = applyAgentWorkflow;
  }, [applyAgentWorkflow]);

  const runnersRef = React.useRef({ runSignatureValidation, runMetricValidation });
  React.useEffect(() => {
    runnersRef.current = { runSignatureValidation, runMetricValidation };
  }, [runSignatureValidation, runMetricValidation]);

  const versionsRef = React.useRef({ signatureVersions, metricVersions });
  React.useEffect(() => {
    versionsRef.current = { signatureVersions, metricVersions };
  }, [signatureVersions, metricVersions]);

  React.useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const onBriefRef = React.useRef(onBrief);
  React.useEffect(() => {
    onBriefRef.current = onBrief;
  }, [onBrief]);

  const hasRequiredContext = React.useMemo(() => {
    if (blackbox) return blackbox.objective.trim().length > 0;
    if (!parsedDataset || parsedDataset.rowCount === 0) return false;
    const hasInput = Object.values(columnRoles).some((r) => r === "input");
    const hasOutput = Object.values(columnRoles).some((r) => r === "output");
    return hasInput && hasOutput;
  }, [parsedDataset, columnRoles, blackbox]);
  // A black-box chat needs nothing up front: with no objective yet, the agent
  // asks for it. Only the seed draft waits for one.
  const canChat = blackbox ? true : hasRequiredContext;

  const appendReply = React.useCallback((chunk: string) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (!last || last.role !== "assistant") return prev;
      const next = prev.slice();
      next[next.length - 1] = { ...last, content: last.content + chunk };
      return next;
    });
  }, []);

  const pushToolCall = React.useCallback((call: AgentToolCall) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (!last || last.role !== "assistant") return prev;
      const next = prev.slice();
      next[next.length - 1] = {
        ...last,
        toolCalls: [...(last.toolCalls ?? []), call],
      };
      return next;
    });
  }, []);

  const finishToolCall = React.useCallback((id: string, status: AgentToolStatus) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (!last || last.role !== "assistant" || !last.toolCalls?.length) return prev;
      const next = prev.slice();
      next[next.length - 1] = {
        ...last,
        toolCalls: last.toolCalls.map((t) =>
          t.id === id ? { ...t, status, endedAt: Date.now() } : t,
        ),
      };
      return next;
    });
  }, []);

  const attachCodeToLatestRunningToolCall = React.useCallback(
    (slot: "seed" | "scorer", prevCode: string, newCode: string) => {
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (!last || last.role !== "assistant" || !last.toolCalls?.length) return prev;
        const calls = last.toolCalls;
        let targetIdx = -1;
        for (let i = calls.length - 1; i >= 0; i--) {
          const c = calls[i];
          if (
            c &&
            c.status === "running" &&
            (slot === "seed" ? isSeedTool(c.tool) : isScorerTool(c.tool))
          ) {
            targetIdx = i;
            break;
          }
        }
        if (targetIdx < 0) return prev;
        const updatedCalls = calls.slice();
        const target = updatedCalls[targetIdx];
        if (!target) return prev;
        updatedCalls[targetIdx] = { ...target, prevCode, newCode };
        const next = prev.slice();
        next[next.length - 1] = { ...last, toolCalls: updatedCalls };
        return next;
      });
    },
    [],
  );

  const runAgent = React.useCallback(
    (userMessage: string, history: AgentMessage[], kickoff = false) => {
      const isChat = userMessage.length > 0 || kickoff;
      if (!(isChat ? canChat : hasRequiredContext)) return;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      sigBufRef.current = "";
      metricBufRef.current = "";
      replyBufRef.current = "";
      reasoningBufRef.current = "";
      reasoningSectionsRef.current = { order: [], bufs: {} };
      reasoningEndedRef.current = false;
      pendingValidationsRef.current = [];
      setQuestion(null);

      setMode(isChat ? "chat" : "seed");
      setStatus("streaming");
      setOpeningRun(kickoff);
      setLimitReached(false);
      setStatusLabel(
        kickoff
          ? formatMsg("submit.blackbox.agent.opening_title", { repo: blackbox?.repository ?? "" })
          : isChat
          ? msg("auto.features.submit.hooks.use.code.agent.literal.1")
          : blackbox
            ? msg("submit.blackbox.agent.reading")
            : formatMsg("auto.features.submit.hooks.use.code.agent.template.2", {
                p1: TERMS.dataset,
              }),
      );
      setSignatureStatus(isChat ? "idle" : "waiting");
      setMetricStatus(isChat ? "idle" : "waiting");
      setReasoning("");
      setReasoningStartedAt(Date.now());
      setReasoningEndedAt(null);
      setError(null);

      if (kickoff) {
        // The opening message is the server's and stays hidden: the chat
        // starts with the agent's reply, about this repository only.
        setMessages([{ role: "assistant", content: "", toolCalls: [] }]);
      } else if (isChat) {
        setMessages((m) => [
          ...m,
          { role: "user", content: userMessage },
          { role: "assistant", content: "", toolCalls: [] },
        ]);
      } else {
        setMessages((m) => [
          ...m,
          { role: "user", content: seedUserMessage(!!blackbox) },
          { role: "assistant", content: "", toolCalls: [] },
        ]);
      }

      const sampleRows = (parsedDataset?.rows.slice(0, 5) ?? []) as Array<Record<string, unknown>>;
      const snapshot = snapshotRef.current;
      const { signatureVersions: sigVers, metricVersions: metVers } = versionsRef.current;
      const initialSignature = sigVers[0]?.code ?? snapshot.signatureCode;
      const initialMetric = metVers[0]?.code ?? snapshot.metricCode;
      // Track the prevCode for replace callbacks within this run. The outer
      // `snapshot` is captured at run-start, so reading it on the second
      // replace would diff against the run's starting code instead of the
      // previous version — the tool-call card would show a stale diff.
      let lastSignatureCode = snapshot.signatureCode;
      let lastMetricCode = snapshot.metricCode;
      const chatHistory = history
        .filter((m) => m.content.trim().length > 0)
        .map((m) => ({ role: m.role, content: m.content }));

      // Send only image-typed entries — the backend defaults the rest to
      // text. Keeps the payload lean and makes the wire shape symmetric
      // with the wizard's mental model: text is the default.
      const imageColumnKinds: Record<string, "image"> = {};
      for (const [col, kind] of Object.entries(columnKinds)) {
        if (kind === "image") imageColumnKinds[col] = "image";
      }

      const priorWorkflow = isWorkflow ? (snapshot.workflowSpec ?? null) : null;
      if (isWorkflow && !initialWorkflowRef.current && priorWorkflow) {
        initialWorkflowRef.current = priorWorkflow;
      }

      // Stop the thinking timer as soon as artifact output starts flowing —
      // otherwise "Thinking" keeps pulsing through the whole code-writing
      // stretch (which renders in the editors, not the chat) and the stream
      // reads as stuck.
      const markReasoningDone = () => {
        if (reasoningBufRef.current && !reasoningEndedRef.current) {
          reasoningEndedRef.current = true;
          setReasoningEndedAt(Date.now());
        }
      };

      void streamCodeAgent(
        {
          dataset_columns: parsedDataset?.columns ?? [],
          column_roles: columnRoles,
          column_kinds: imageColumnKinds,
          sample_rows: sampleRows,
          user_message: userMessage,
          chat_history: chatHistory,
          prior_signature: snapshot.signatureCode,
          prior_metric: snapshot.metricCode,
          prior_signature_validation: summarizeValidation(snapshot.signatureValidation),
          prior_metric_validation: summarizeValidation(snapshot.metricValidation),
          initial_signature: initialSignature,
          initial_metric: initialMetric,
          locale: getActiveLocale(),
          ...(interviewBrief && interviewBrief.length > 0
            ? { interview_brief: interviewBrief }
            : {}),
          ...(isWorkflow
            ? {
                prior_workflow: priorWorkflow,
                initial_workflow: initialWorkflowRef.current ?? priorWorkflow,
              }
            : {}),
          ...(model ? { model } : {}),
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
          ...(blackbox ? { blackbox } : {}),
          ...(kickoff ? { kickoff: true } : {}),
        },
        {
          signal: controller.signal,
          onReasoningPatch: (chunk, source) => {
            if (reasoningBufRef.current === "") {
              setReasoningStartedAt(Date.now());
            }
            const sections = reasoningSectionsRef.current;
            if (!(source in sections.bufs)) {
              sections.order.push(source);
              sections.bufs[source] = "";
            }
            sections.bufs[source] += chunk;
            reasoningBufRef.current = composeReasoning(sections);
            setReasoning(reasoningBufRef.current);
          },
          onSignaturePatch: (chunk) => {
            if (sigBufRef.current === "") {
              setStatusLabel(msg("auto.features.submit.hooks.use.code.agent.literal.2"));
              setSignatureStatus("writing");
              markReasoningDone();
            }
            sigBufRef.current += chunk;
            setSignatureCode(sigBufRef.current);
            setSignatureValidation(null);
          },
          onMetricPatch: (chunk) => {
            if (metricBufRef.current === "") {
              setStatusLabel(msg("auto.features.submit.hooks.use.code.agent.literal.3"));
              setSignatureStatus("done");
              setMetricStatus("writing");
              markReasoningDone();
            }
            metricBufRef.current += chunk;
            setMetricCode(metricBufRef.current);
            setMetricValidation(null);
          },
          onMessagePatch: (chunk) => {
            if (replyBufRef.current === "") {
              setStatusLabel(msg("auto.features.submit.hooks.use.code.agent.literal.4"));
              markReasoningDone();
            }
            replyBufRef.current += chunk;
            appendReply(chunk);
          },
          onAsk: (ask) => {
            if (controller.signal.aborted) return;
            setQuestion(ask.options.length > 0 ? ask : null);
          },
          onBrief: (fields) => {
            if (controller.signal.aborted) return;
            onBriefRef.current?.(fields);
          },
          onToolStart: (ev) => {
            markReasoningDone();
            setStatusLabel(
              isRepoTool(ev.tool)
                ? msg("submit.blackbox.agent.reading_repo")
                : ev.tool === "set_brief"
                  ? msg("submit.blackbox.agent.writing_brief")
                  : isSeedTool(ev.tool)
                    ? msg(
                        blackbox
                          ? "submit.blackbox.agent.writing_seed"
                          : "auto.features.submit.hooks.use.code.agent.literal.5",
                      )
                    : isScorerTool(ev.tool)
                      ? msg(
                          blackbox
                            ? "submit.blackbox.agent.writing_scorer"
                            : "auto.features.submit.hooks.use.code.agent.literal.6",
                        )
                      : msg("workflow.agent.editing_graph"),
            );
            if (isSeedTool(ev.tool)) setSignatureStatus("writing");
            else if (isScorerTool(ev.tool)) setMetricStatus("writing");
            pushToolCall({
              id: ev.id,
              tool: ev.tool,
              reason: ev.reason,
              status: "running",
              startedAt: Date.now(),
              endedAt: null,
            });
          },
          onToolEnd: (ev) => {
            finishToolCall(ev.id, ev.status === "ok" ? "done" : "error");
            if (isSeedTool(ev.tool)) setSignatureStatus("done");
            else if (isScorerTool(ev.tool)) setMetricStatus("done");
          },
          onWorkflowReplace: (workflow, changedNodeId) => {
            markReasoningDone();
            applyAgentWorkflowRef.current?.(workflow, changedNodeId);
          },
          onSignatureReplace: (code) => {
            const prevCode = lastSignatureCode;
            lastSignatureCode = code;
            setSignatureCode(code);
            setSignatureManuallyEdited(false);
            attachCodeToLatestRunningToolCall("seed", prevCode, code);
            const changed = diffChangedLines(prevCode, code);
            setSignatureFlashLines(changed);
            if (flashClearRef.current) clearTimeout(flashClearRef.current);
            flashClearRef.current = setTimeout(() => {
              setSignatureFlashLines([]);
            }, 1200);
            setSignatureVersions((prev) => {
              const next = [...prev, { code, ts: Date.now() }];
              setSignatureVersionIndex(next.length - 1);
              return next;
            });
            pendingValidationsRef.current.push({
              kind: "signature",
              promise: runnersRef.current.runSignatureValidation(code),
            });
          },
          onMetricReplace: (code) => {
            const prevCode = lastMetricCode;
            lastMetricCode = code;
            setMetricCode(code);
            setMetricManuallyEdited(false);
            attachCodeToLatestRunningToolCall("scorer", prevCode, code);
            const changed = diffChangedLines(prevCode, code);
            setMetricFlashLines(changed);
            if (flashClearRef.current) clearTimeout(flashClearRef.current);
            flashClearRef.current = setTimeout(() => {
              setMetricFlashLines([]);
            }, 1200);
            setMetricVersions((prev) => {
              const next = [...prev, { code, ts: Date.now() }];
              setMetricVersionIndex(next.length - 1);
              return next;
            });
            pendingValidationsRef.current.push({
              kind: "metric",
              promise: runnersRef.current.runMetricValidation(code),
            });
          },
          onDone: async (result) => {
            // A superseded/reset run's late completion must not clobber the
            // fresh session (mirrors the onError guard below). The check at
            // the auto-fix step still matters — abort can land while the
            // validations above are awaited.
            if (controller.signal.aborted) return;
            if (!isChat && isWorkflow) {
              // Workflow seed: the graph landed via workflow_replace (or
              // rides the done payload after a repair); only the metric
              // flows through the code editor.
              if (result.workflow) {
                applyAgentWorkflowRef.current?.(result.workflow, null);
              }
              setMetricCode(result.metric_code);
              setMetricManuallyEdited(false);
              setMetricVersions((prev) => {
                const next = [...prev, { code: result.metric_code, ts: Date.now() }];
                setMetricVersionIndex(next.length - 1);
                return next;
              });
              pendingValidationsRef.current.push({
                kind: "metric",
                promise: runnersRef.current.runMetricValidation(result.metric_code),
              });
            } else if (!isChat) {
              setSignatureCode(result.signature_code);
              setMetricCode(result.metric_code);
              setSignatureManuallyEdited(false);
              setMetricManuallyEdited(false);
              const sigChanged = diffChangedLines(snapshot.signatureCode, result.signature_code);
              const metChanged = diffChangedLines(snapshot.metricCode, result.metric_code);
              setSignatureFlashLines(sigChanged);
              setMetricFlashLines(metChanged);
              if (flashClearRef.current) clearTimeout(flashClearRef.current);
              flashClearRef.current = setTimeout(() => {
                setSignatureFlashLines([]);
                setMetricFlashLines([]);
              }, 800);
              setSignatureVersions((prev) => {
                const next = [...prev, { code: result.signature_code, ts: Date.now() }];
                setSignatureVersionIndex(next.length - 1);
                return next;
              });
              setMetricVersions((prev) => {
                const next = [...prev, { code: result.metric_code, ts: Date.now() }];
                setMetricVersionIndex(next.length - 1);
                return next;
              });
              pendingValidationsRef.current.push({
                kind: "signature",
                promise: runnersRef.current.runSignatureValidation(result.signature_code),
              });
              pendingValidationsRef.current.push({
                kind: "metric",
                promise: runnersRef.current.runMetricValidation(result.metric_code),
              });
            }
            setSignatureStatus("done");
            setMetricStatus("done");
            setStatus("done");
            setStatusLabel(msg("auto.features.submit.hooks.use.code.agent.literal.7"));
            if (reasoningBufRef.current) setReasoningEndedAt(Date.now());

            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (!last || last.role !== "assistant") return prev;
              const fallback = isChat
                ? "Done."
                : blackbox
                  ? msg("submit.blackbox.agent.seed_done")
                  : "I wrote a Signature and Metric based on your data.";
              const finalContent = result.assistant_message || last.content || fallback;
              const next = prev.slice();
              next[next.length - 1] = {
                ...last,
                content: finalContent,
                model: result.model,
                servedModel: result.served_model,
                stats: result.stats,
              };
              return next;
            });

            // Auto-fix: wait for any validations kicked off during this run,
            // then if the validator flagged errors, fire a follow-up chat
            // turn so the agent can see the errors (via prior_*_validation)
            // and patch them. Bounded by MAX_AUTO_FIX to prevent loops.
            const pending = pendingValidationsRef.current;
            pendingValidationsRef.current = [];
            if (pending.length === 0) return;
            // allSettled so a single failed validation doesn't suppress
            // auto-fix for the other kind. A rejection here means the
            // validation request itself errored (network/server) — there
            // is nothing concrete for the agent to patch in that case, so
            // we skip just that entry rather than aborting the whole run.
            const settled = await Promise.allSettled(pending.map((e) => e.promise));
            const responses: Array<ValidateCodeResponse | null> = settled.map((r) =>
              r.status === "fulfilled" ? ((r.value as ValidateCodeResponse | null) ?? null) : null,
            );
            for (let i = 0; i < pending.length; i++) {
              const entry = pending[i];
              if (!entry) continue;
              const resp = responses[i] ?? null;
              if (entry.kind === "signature") {
                snapshotRef.current = {
                  ...snapshotRef.current,
                  signatureValidation: resp,
                };
              } else {
                snapshotRef.current = {
                  ...snapshotRef.current,
                  metricValidation: resp,
                };
              }
            }
            let signatureHasError = false;
            let metricHasError = false;
            for (let i = 0; i < pending.length; i++) {
              const entry = pending[i];
              const resp = responses[i];
              const broken = !!resp && !resp.valid && resp.errors.length > 0;
              if (!entry || !broken) continue;
              if (entry.kind === "signature") signatureHasError = true;
              else metricHasError = true;
            }
            if (!signatureHasError && !metricHasError) return;
            if (controller.signal.aborted) return;
            if (autoFixAttemptsRef.current >= MAX_AUTO_FIX) return;
            autoFixAttemptsRef.current += 1;
            // Name only the artifact(s) that actually failed so the retry
            // message (the chat bubble the user reads) points at the real
            // problem instead of blaming both. The per-artifact validation
            // summaries in the request body already carry the concrete errors.
            const fixKey =
              signatureHasError && metricHasError
                ? "auto.features.submit.hooks.use.code.agent.template.3"
                : metricHasError
                  ? "auto.features.submit.hooks.use.code.agent.template.5"
                  : "auto.features.submit.hooks.use.code.agent.template.4";
            const fixMessage = blackbox
              ? msg("submit.blackbox.agent.fix_scorer")
              : formatMsg(fixKey, {
                  p1: TERMS.dataset,
                });
            queueMicrotask(() => {
              runAgentRef.current?.(fixMessage, messagesRef.current);
            });
          },
          onError: (message, code) => {
            if (controller.signal.aborted) return;
            setLimitReached(code === DAILY_LIMIT_CODE);
            setStatus("error");
            setStatusLabel(msg("auto.features.submit.hooks.use.code.agent.literal.8"));
            setSignatureStatus("idle");
            setMetricStatus("idle");
            setError(message);
            // Drop the empty placeholder agent bubble so the error UI
            // isn't followed by a blank message.
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last && last.role === "assistant" && !last.content && !last.toolCalls?.length) {
                return prev.slice(0, -1);
              }
              return prev;
            });
          },
        },
      );
    },
    [
      parsedDataset,
      hasRequiredContext,
      canChat,
      columnRoles,
      columnKinds,
      isWorkflow,
      interviewBrief,
      blackbox,
      model,
      reasoningEffort,
      setSignatureCode,
      setMetricCode,
      setSignatureValidation,
      setMetricValidation,
      setSignatureManuallyEdited,
      setMetricManuallyEdited,
      appendReply,
      pushToolCall,
      finishToolCall,
      attachCodeToLatestRunningToolCall,
    ],
  );

  React.useEffect(() => {
    runAgentRef.current = runAgent;
  }, [runAgent]);

  const send = React.useCallback(
    (message: string) => {
      const trimmed = message.trim();
      if (!trimmed) return;
      autoFixAttemptsRef.current = 0;
      runAgent(trimmed, messages);
    },
    [runAgent, messages],
  );

  const editAndResend = React.useCallback(
    (messageIndex: number, content: string) => {
      const trimmed = content.trim();
      if (!trimmed) return;
      const truncated = messages.slice(0, messageIndex);
      setMessages(truncated);
      autoFixAttemptsRef.current = 0;
      runAgent(trimmed, truncated);
    },
    [runAgent, messages],
  );

  const retry = React.useCallback(() => {
    const lastUserIndex = [...messages].reverse().findIndex((m) => m.role === "user");
    if (lastUserIndex === -1) {
      if (openingRun) runAgent("", [], true);
      return;
    }
    const index = messages.length - 1 - lastUserIndex;
    const lastUser = messages[index];
    const truncated = messages.slice(0, index);
    setMessages(truncated);
    autoFixAttemptsRef.current = 0;
    runAgent(lastUser?.content ?? "", truncated);
  }, [messages, runAgent, openingRun]);

  const goToSignatureVersion = React.useCallback(
    (index: number) => {
      const v = signatureVersions[index];
      if (!v) return;
      setSignatureCode(v.code);
      setSignatureManuallyEdited(false);
      setSignatureVersionIndex(index);
      void runnersRef.current.runSignatureValidation(v.code);
    },
    [signatureVersions, setSignatureCode, setSignatureManuallyEdited],
  );

  const goToMetricVersion = React.useCallback(
    (index: number) => {
      const v = metricVersions[index];
      if (!v) return;
      setMetricCode(v.code);
      setMetricManuallyEdited(false);
      setMetricVersionIndex(index);
      void runnersRef.current.runMetricValidation(v.code);
    },
    [metricVersions, setMetricCode, setMetricManuallyEdited],
  );

  const fallbackToManual = React.useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setCodeAssistMode("manual");
    toast.info(msg("auto.features.submit.hooks.use.code.agent.literal.9"));
  }, [setCodeAssistMode]);

  const stop = React.useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStatus("idle");
    setStatusLabel("");
    setSignatureStatus("idle");
    setMetricStatus("idle");
  }, []);

  const reset = React.useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    sigBufRef.current = "";
    metricBufRef.current = "";
    replyBufRef.current = "";
    reasoningBufRef.current = "";
    reasoningSectionsRef.current = { order: [], bufs: {} };
    reasoningEndedRef.current = false;
    pendingValidationsRef.current = [];
    autoFixAttemptsRef.current = 0;
    autoRanRef.current = false;
    if (flashClearRef.current) {
      clearTimeout(flashClearRef.current);
      flashClearRef.current = null;
    }
    setMessages([]);
    setQuestion(null);
    setStatus("idle");
    setOpeningRun(false);
    setKickedKey(null);
    setLimitReached(false);
    setMode("seed");
    setStatusLabel("");
    setSignatureStatus("idle");
    setMetricStatus("idle");
    setError(null);
    setReasoning("");
    setReasoningStartedAt(null);
    setReasoningEndedAt(null);
    setSignatureVersions([]);
    setMetricVersions([]);
    setSignatureVersionIndex(-1);
    setMetricVersionIndex(-1);
    setSignatureFlashLines([]);
    setMetricFlashLines([]);
    initialWorkflowRef.current = null;
    // Clear the manual-edit gate so the auto-seed effect re-fires on
    // sessionKey bump — otherwise "new chat" would wipe the messages
    // but leave the old Signature/Metric untouched.
    setSignatureManuallyEdited(false);
    setMetricManuallyEdited(false);
    setSessionKey((k) => k + 1);
  }, [setSignatureManuallyEdited, setMetricManuallyEdited]);

  // Swapping the dataset invalidates the entire conversation: messages,
  // version history, and any in-flight stream all refer to schemas that no
  // longer apply. Identity change is a reliable signal — `parseDatasetFile`
  // returns a fresh object per upload. Skipping the initial null→value
  // transition keeps the first mount a no-op.
  const prevDatasetRef = React.useRef(parsedDataset);
  React.useEffect(() => {
    if (prevDatasetRef.current !== parsedDataset) {
      if (prevDatasetRef.current !== null) {
        reset();
      } else {
        autoRanRef.current = false;
      }
      prevDatasetRef.current = parsedDataset;
    }
  }, [parsedDataset, reset]);

  // Re-arm when the user changes their DSPy module (predict ↔ chain_of_thought
  // ↔ react, …). The manual-edit gate still protects user-authored edits;
  // fresh seed output just flips to the new module's expected shape.
  React.useEffect(() => {
    autoRanRef.current = false;
  }, [moduleName]);

  // Kick off the seed run as soon as the user has a dataset + I/O roles.
  // This hook lives at the wizard level, so the seed fires even when the
  // user hasn't arrived at the code step yet — by the time they do, the
  // editors are already filled (or actively filling). We skip the seed
  // if either artifact has been manually authored (including clone-pre-fill,
  // which marks both flags true) — a fresh dataset upload clears the flags.
  React.useEffect(() => {
    if (codeAssistMode !== "auto") return;
    if (!seedEnabled) return;
    if (autoRanRef.current) return;
    if (!hasRequiredContext) return;
    // Workflow mode waits for the wizard's starter graph (the request needs
    // a prior_workflow to route the graph-aware path) and respects canvas
    // edits the way the code path respects manual code edits.
    if (isWorkflow && (!workflowSpec || workflowTouched || metricManuallyEdited)) return;
    if (!isWorkflow && (signatureManuallyEdited || metricManuallyEdited)) return;
    autoRanRef.current = true;
    autoFixAttemptsRef.current = 0;
    runAgent("", []);
  }, [
    codeAssistMode,
    seedEnabled,
    hasRequiredContext,
    signatureManuallyEdited,
    metricManuallyEdited,
    isWorkflow,
    workflowSpec,
    workflowTouched,
    runAgent,
    sessionKey,
  ]);

  // A picked repository opens the conversation once per repository/branch;
  // picking another one starts over about it, and so does a new chat.
  // Clearing the pick keeps the chat, and picking the same one again does
  // not repeat the opening.
  const kickoffKey =
    kickoffEnabled && codeAssistMode === "auto" && blackbox?.repository
      ? `${blackbox.repository}@${blackbox.branch ?? ""}`
      : null;
  React.useEffect(() => {
    if (!kickoffKey || kickedKey === kickoffKey) return;
    const timer = setTimeout(() => {
      setKickedKey(kickoffKey);
      autoFixAttemptsRef.current = 0;
      runAgentRef.current?.("", [], true);
    }, KICKOFF_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [kickoffKey, kickedKey]);

  const firstMessage = messages[0];
  const awaitingFirstWords =
    openingRun &&
    status === "streaming" &&
    messages.length === 1 &&
    !firstMessage?.content &&
    !firstMessage?.toolCalls?.length;
  const openingRepo =
    (kickoffKey !== null && kickedKey !== kickoffKey) || awaitingFirstWords
      ? (blackbox?.repository ?? null)
      : null;

  // If the user switches to manual mid-stream, abort and reset.
  React.useEffect(() => {
    if (codeAssistMode === "auto") return;
    abortRef.current?.abort();
    abortRef.current = null;
  }, [codeAssistMode]);

  return {
    status,
    mode,
    statusLabel,
    signatureStatus,
    metricStatus,
    messages,
    error,
    limitReached,
    openingRepo,
    canSend: canChat && status !== "streaming",
    question,
    signatureVersions,
    metricVersions,
    signatureVersionIndex,
    metricVersionIndex,
    signatureFlashLines,
    metricFlashLines,
    reasoning,
    reasoningStartedAt,
    reasoningEndedAt,
    goToSignatureVersion,
    goToMetricVersion,
    send,
    editAndResend,
    retry,
    fallbackToManual,
    stop,
    reset,
  };
}
