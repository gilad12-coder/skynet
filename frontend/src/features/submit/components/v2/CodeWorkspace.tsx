"use client";

import type { ReactNode } from "react";
import { LazyCodeEditor as CodeEditor } from "@/shared/ui/lazy-code-editor";
import type { CodeAgentState } from "@/shared/hooks/use-code-agent";
import { withScorerImports } from "../../lib/scorer-dependencies";
import { ArtifactStatusChip } from "../steps/AuthoringShell";
import { VersionStepper } from "../steps/CodeAgentPanel";
import { v2Msg } from "./ArtifactConfirmCard";

function EditorBlock({
  id,
  title,
  hint,
  agent,
  artifact,
  children,
}: {
  id: string;
  title: string;
  hint: string;
  agent: CodeAgentState | null;
  artifact: "signature" | "metric";
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <h4 id={`${id}-label`} className="text-sm font-medium">
            {title}
          </h4>
          <code
            dir="ltr"
            className="block truncate font-mono text-[0.6875rem] text-muted-foreground"
            title={hint}
          >
            {hint}
          </code>
        </div>
        {agent && (
          <div className="flex items-center gap-2">
            <VersionStepper agent={agent} artifact={artifact} />
            <ArtifactStatusChip
              status={artifact === "signature" ? agent.signatureStatus : agent.metricStatus}
            />
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

/**
 * The two editors of the unified workspace: the run code (how a candidate
 * produces an output) and the metric (how that output is scored). The agent's
 * version stepper and writing status show only while it is driving.
 */
export function CodeWorkspace({
  runCode,
  metricCode,
  onRunCodeChange,
  onMetricCodeChange,
  runHint,
  metricHint,
  agent,
  guided,
  children,
}: {
  runCode: string;
  metricCode: string;
  onRunCodeChange: (code: string) => void;
  onMetricCodeChange: (code: string) => void;
  runHint: string;
  metricHint: string;
  /** The agent, while auto mode drives the editors; null in manual mode. */
  agent: CodeAgentState | null;
  guided: boolean;
  /** Rendered between the run and metric editors (the metric model row). */
  children?: ReactNode;
}) {
  return (
    <div className="space-y-5 px-4 py-4 sm:px-6">
      <EditorBlock
        id="v2-run-code"
        title={v2Msg("submit.v2.metric.run_label", guided)}
        hint={runHint}
        agent={agent}
        artifact="signature"
      >
        <CodeEditor
          value={runCode}
          onChange={onRunCodeChange}
          height="300px"
          streaming={agent?.signatureStatus === "writing"}
          flashLines={agent?.signatureFlashLines}
        />
      </EditorBlock>

      <EditorBlock
        id="v2-metric-code"
        title={v2Msg("submit.v2.metric.metric_label", guided)}
        hint={metricHint}
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
            height="300px"
            streaming={agent?.metricStatus === "writing"}
            flashLines={agent?.metricFlashLines}
          />
        </div>
      </EditorBlock>
    </div>
  );
}
