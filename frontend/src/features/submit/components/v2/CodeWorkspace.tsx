"use client";

import { useCallback, useMemo, type ReactNode } from "react";
import { LazyCodeEditor as CodeEditor } from "@/shared/ui/lazy-code-editor";
import type { CodeAgentState } from "@/shared/hooks/use-code-agent";
import { contractCheckMessage } from "@/shared/lib/i18n";
import type { ContractCheckItem, ContractCheckResponse } from "@/shared/types/unified-run";
import { contractConsole, type ContractEditor } from "../../lib/contract-console";
import { withScorerImports } from "../../lib/scorer-dependencies";
import { ArtifactStatusChip } from "../steps/AuthoringShell";
import { VersionStepper } from "../steps/CodeAgentPanel";
import { v2Msg } from "./ArtifactConfirmCard";

/** One failed check as a line in an editor's console. */
function contractConsoleLine(item: ContractCheckItem, guided: boolean): string {
  const where =
    item.sample_index != null
      ? `${v2Msg("submit.v2.metric.check.sample_title", guided, { index: item.sample_index + 1 })}: `
      : "";
  const head = `${where}${contractCheckMessage(item)}`;
  return item.detail ? `${head}\n${item.detail}` : head;
}

// Both editors and the validity check share one screen.
const EDITOR_HEIGHT = "max(14rem, calc(50svh - 14rem))";
// What the black-box runner calls on a repository run, with the checkout's path.
const REPO_SCORER_SIGNATURE = "def score(repo_path, case=None) -> float | dict";

// What a person writing the code by hand must define, straight from the
// contract the coding agent writes under; nothing when the catalog is unknown.
function ContractHint({ text }: { text: string | null | undefined }) {
  if (!text) return null;
  return (
    <p dir="ltr" className="font-mono text-xs text-muted-foreground">
      {text}
    </p>
  );
}

function EditorBlock({
  id,
  title,
  agent,
  artifact,
  children,
}: {
  id: string;
  title: string;
  agent: CodeAgentState;
  artifact: "signature" | "metric";
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={`${id}-label`} className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id={`${id}-label`} className="text-sm font-medium">
          {title}
        </h4>
        <div className="flex items-center gap-2">
          <VersionStepper agent={agent} artifact={artifact} />
          <ArtifactStatusChip
            status={artifact === "signature" ? agent.signatureStatus : agent.metricStatus}
          />
        </div>
      </div>
      {children}
    </section>
  );
}

/**
 * The run code (how a candidate produces an output) and the metric (how that
 * output is scored), stacked on one screen. Every program uses the same
 * contract: the agent writes both, the user can edit either.
 */
export function CodeWorkspace({
  runCode,
  metricCode,
  onRunCodeChange,
  onMetricCodeChange,
  agent,
  guided,
  runEntry,
  metricSignature,
  checkResult,
  onCheck,
  repo = false,
  children,
}: {
  runCode: string;
  metricCode: string;
  onRunCodeChange: (code: string) => void;
  onMetricCodeChange: (code: string) => void;
  agent: CodeAgentState;
  guided: boolean;
  /** The run code's entry point for the artifact kind, from the optimizer catalog. */
  runEntry?: string | null;
  /** The metric's signature for the chosen optimizer, from the optimizer catalog. */
  metricSignature?: string | null;
  /** The last sandboxed contract check; each editor's console shows its own failures. */
  checkResult: ContractCheckResponse | null;
  /** Runs the contract check from either editor's Run button. */
  onCheck: () => Promise<ContractCheckResponse | null>;
  /**
   * A repository run: the checkout is the candidate, so there is no run code,
   * and the scorer is checked on the server at submit.
   */
  repo?: boolean;
  /** Rendered above the metric editor (the metric model row). */
  children?: ReactNode;
}) {
  const consoleFor = useCallback(
    (result: ContractCheckResponse | null, editor: ContractEditor) =>
      contractConsole(result, editor, (item) => contractConsoleLine(item, guided)),
    [guided],
  );
  const runConsole = useMemo(() => consoleFor(checkResult, "run"), [consoleFor, checkResult]);
  const metricConsole = useMemo(() => consoleFor(checkResult, "metric"), [consoleFor, checkResult]);
  const runCheck = useCallback(
    async () => consoleFor(await onCheck(), "run"),
    [consoleFor, onCheck],
  );
  const runMetricCheck = useCallback(
    async () => consoleFor(await onCheck(), "metric"),
    [consoleFor, onCheck],
  );
  const runLabel = v2Msg("submit.v2.metric.check.run", guided);
  const runningLabel = v2Msg("submit.v2.metric.check.running", guided);

  return (
    <div className="space-y-5 px-4 py-4 sm:px-6">
      {!repo && (
      <EditorBlock
        id="v2-run-code"
        title={v2Msg("submit.v2.metric.run_label", guided)}
        agent={agent}
        artifact="signature"
      >
        <CodeEditor
          value={runCode}
          onChange={onRunCodeChange}
          height={EDITOR_HEIGHT}
          onRun={runCheck}
          runLabel={runLabel}
          runningLabel={runningLabel}
          validationResult={runConsole}
          streaming={agent.signatureStatus === "writing"}
          flashLines={agent.signatureFlashLines}
        />
        <ContractHint text={runEntry} />
      </EditorBlock>
      )}

      <EditorBlock
        id="v2-metric-code"
        title={v2Msg("submit.v2.metric.metric_label", guided)}
        agent={agent}
        artifact="metric"
      >
        {children}
        <div
          tabIndex={-1}
          className="outline-none"
          onBlur={(event) => {
            // The sandbox still injects `llm` for old scorers; making the
            // import explicit keeps the code honest about what it calls.
            if (!event.currentTarget.contains(event.relatedTarget)) {
              const code = withScorerImports(metricCode);
              if (code !== metricCode) onMetricCodeChange(code);
            }
          }}
        >
          <CodeEditor
            value={metricCode}
            onChange={onMetricCodeChange}
            height={EDITOR_HEIGHT}
            onRun={repo ? undefined : runMetricCheck}
            runLabel={runLabel}
            runningLabel={runningLabel}
            validationResult={repo ? undefined : metricConsole}
            streaming={agent.metricStatus === "writing"}
            flashLines={agent.metricFlashLines}
          />
        </div>
        <ContractHint text={repo ? REPO_SCORER_SIGNATURE : metricSignature} />
      </EditorBlock>
    </div>
  );
}
