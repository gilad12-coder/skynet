"use client";

import * as React from "react";
import { useCodeAgent, type CodeAgentState } from "@/shared/hooks/use-code-agent";
import type { ValidateCodeResponse } from "@/shared/types/api";
import type { ContractCheckResponse, UnifiedAuthoringContext } from "@/shared/types/unified-run";
import { v2Msg } from "../components/v2/ArtifactConfirmCard";
import { kickoffFor } from "./kickoff";

const NO_COLUMNS: Record<string, never> = {};
// The wizard checks the workspace with its own Check; the agent checks inside its turn with verify_code.
const noValidation = async () => null;

export interface IdeCodingAgent {
  agent: CodeAgentState;
  model: string | null;
  setModel: (model: string | null) => void;
  effort: string | null;
  setEffort: (effort: string | null) => void;
}

/**
 * The IDE's one coding agent: it writes run.py, metric.py and the helper
 * files straight into the wizard's workspace, and talks in the IDE's panel.
 *
 * When the step opens on work the user has not done (blank entry files, or
 * its own code that failed the last Check), it starts by itself with a turn
 * the transcript does not show as the user's. After each of its turns the
 * step runs Check, so the results under the toolbar match its code.
 *
 * Args:
 *   options.context: The authoring context, or null when the agent cannot write (a repository run).
 *   options.active: The step is on screen.
 *   options.dataKnown: The agent has sample cases, or the task needs none.
 *   options.runCode / metricCode / files: The workspace.
 *   options.setRunCode / setMetricCode / setFile: Write into the workspace.
 *   options.lastCheckOk: The last Check's verdict on exactly these files, or null.
 *   options.check: Run Check.
 *   options.guided: Guided copy for the kickoff turns.
 *
 * Returns:
 *   The agent and its composer model choice.
 */
export function useIdeCodingAgent(options: {
  context: UnifiedAuthoringContext | null;
  active: boolean;
  dataKnown: boolean;
  runCode: string;
  metricCode: string;
  files: Readonly<Record<string, string>>;
  setRunCode: (code: string) => void;
  setMetricCode: (code: string) => void;
  setFile: (path: string, text: string | null) => void;
  lastCheckOk: boolean | null;
  check: () => Promise<ContractCheckResponse | null>;
  guided: boolean;
}): IdeCodingAgent {
  const { context, active, dataKnown, runCode, metricCode, files, lastCheckOk, check, guided } = options;
  const [model, setModel] = React.useState<string | null>(null);
  const [effort, setEffort] = React.useState<string | null>(null);
  const [runEdited, setRunEdited] = React.useState(false);
  const [metricEdited, setMetricEdited] = React.useState(false);
  const [runValidation, setRunValidation] = React.useState<ValidateCodeResponse | null>(null);
  const [metricValidation, setMetricValidation] = React.useState<ValidateCodeResponse | null>(null);

  // What the agent itself last wrote: code that differs from it was edited by hand.
  const [agentRun, setAgentRun] = React.useState<string | null>(null);
  const [agentMetric, setAgentMetric] = React.useState<string | null>(null);
  const sinks = React.useRef(options);
  React.useLayoutEffect(() => {
    sinks.current = options;
  });
  const writeRun = React.useCallback((code: string) => {
    setAgentRun(code);
    sinks.current.setRunCode(code);
  }, []);
  const writeMetric = React.useCallback((code: string) => {
    setAgentMetric(code);
    sinks.current.setMetricCode(code);
  }, []);
  const writeFile = React.useCallback(
    (path: string, text: string | null) => sinks.current.setFile(path, text),
    [],
  );

  const agent = useCodeAgent({
    columnRoles: NO_COLUMNS,
    columnKinds: NO_COLUMNS,
    parsedDataset: null,
    moduleName: "",
    signatureCode: runCode,
    metricCode,
    setSignatureCode: writeRun,
    setMetricCode: writeMetric,
    signatureManuallyEdited: runEdited,
    metricManuallyEdited: metricEdited,
    setSignatureManuallyEdited: setRunEdited,
    setMetricManuallyEdited: setMetricEdited,
    setSignatureValidation: setRunValidation,
    setMetricValidation,
    signatureValidation: runValidation,
    metricValidation,
    runSignatureValidation: noValidation,
    runMetricValidation: noValidation,
    // The kickoff below starts the agent; the parallel seed would write without checking.
    seedEnabled: false,
    unified: context,
    files: files as Record<string, string>,
    setFile: writeFile,
    model,
    reasoningEffort: effort,
  });

  // One kickoff per workspace state: re-renders, re-entering the step and a
  // finished turn whose code still fails never start the same turn twice.
  const kicked = React.useRef<string | null>(null);
  const busy = agent.status === "streaming";
  const send = agent.send;
  React.useEffect(() => {
    if (!active) return;
    const kickoff = kickoffFor({
      hasContext: context !== null,
      objective: context?.task.objective ?? "",
      dataKnown,
      runCode,
      metricCode,
      agentRun,
      agentMetric,
      lastCheckOk,
      busy,
    });
    if (!kickoff) return;
    const key = `${kickoff}\u0000${runCode}\u0000${metricCode}`;
    if (kicked.current === key) return;
    kicked.current = key;
    send(v2Msg(`submit.v2.ide.agent.kickoff.${kickoff}`, guided), { hidden: true });
  }, [active, context, dataKnown, runCode, metricCode, agentRun, agentMetric, lastCheckOk, busy, send, guided]);

  // The agent's own verify_code result stays in its chat; Check after its
  // turn puts the same verdict under the toolbar and into the kickoff rule.
  const wasBusy = React.useRef(false);
  React.useEffect(() => {
    const finished = wasBusy.current && agent.status === "done";
    wasBusy.current = busy;
    if (finished && context && runCode.trim() && metricCode.trim()) void check();
  }, [busy, agent.status, context, runCode, metricCode, check]);

  return { agent, model, setModel, effort, setEffort };
}
