"use client";

import type { ReactNode } from "react";
import { LazyCodeEditor as CodeEditor } from "@/shared/ui/lazy-code-editor";
import type { CodeAgentState } from "@/shared/hooks/use-code-agent";
import { withScorerImports } from "../../lib/scorer-dependencies";
import { ArtifactStatusChip } from "../steps/AuthoringShell";
import { VersionStepper } from "../steps/CodeAgentPanel";
import { v2Msg } from "./ArtifactConfirmCard";

// Both editors and the validity check share one screen.
const EDITOR_HEIGHT = "max(14rem, calc(50svh - 14rem))";

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
  children,
}: {
  runCode: string;
  metricCode: string;
  onRunCodeChange: (code: string) => void;
  onMetricCodeChange: (code: string) => void;
  agent: CodeAgentState;
  guided: boolean;
  /** Rendered above the metric editor (the metric model row). */
  children?: ReactNode;
}) {
  return (
    <div className="space-y-5 px-4 py-4 sm:px-6">
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
          streaming={agent.signatureStatus === "writing"}
          flashLines={agent.signatureFlashLines}
        />
      </EditorBlock>

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
            streaming={agent.metricStatus === "writing"}
            flashLines={agent.metricFlashLines}
          />
        </div>
      </EditorBlock>
    </div>
  );
}
