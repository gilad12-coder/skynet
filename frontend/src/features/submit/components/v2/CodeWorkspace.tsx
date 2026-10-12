"use client";

import { useState, type ReactNode } from "react";
import { LazyCodeEditor as CodeEditor } from "@/shared/ui/lazy-code-editor";
import { Segmented } from "@/shared/ui/segmented";
import type { CodeAgentState } from "@/shared/hooks/use-code-agent";
import { withScorerImports } from "../../lib/scorer-dependencies";
import { ArtifactStatusChip } from "../steps/AuthoringShell";
import { VersionStepper } from "../steps/CodeAgentPanel";
import { v2Msg } from "./ArtifactConfirmCard";

type Editor = "run" | "metric";

// The editors share the screen with the validity check below them; the
// editor itself still caps at 60svh on tall screens.
const EDITOR_HEIGHT = "calc(100svh - 30rem)";
const PANEL_ID = "v2-code-editor";

/**
 * The run code (how a candidate produces an output) and the metric (how that
 * output is scored), one editor at a time behind a switch. The agent writes
 * both; the user can edit either. Both editors stay mounted so each keeps its
 * undo history across the switch.
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
  agent: CodeAgentState;
  guided: boolean;
  /** Rendered above the metric editor (the metric model row). */
  children?: ReactNode;
}) {
  const [show, setShow] = useState<Editor>("run");
  const artifact = show === "run" ? "signature" : "metric";
  const status = show === "run" ? agent.signatureStatus : agent.metricStatus;
  const runLabel = v2Msg("submit.v2.metric.run_label", guided);
  const metricLabel = v2Msg("submit.v2.metric.metric_label", guided);

  return (
    <div className="space-y-2 px-4 py-4 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented<Editor>
          size="sm"
          value={show}
          onChange={setShow}
          controls={PANEL_ID}
          options={[
            { value: "run", label: runLabel },
            { value: "metric", label: metricLabel },
          ]}
        />
        <div className="flex items-center gap-2">
          <VersionStepper agent={agent} artifact={artifact} />
          <ArtifactStatusChip status={status} />
        </div>
      </div>
      <code
        dir="ltr"
        className="block truncate font-mono text-[0.6875rem] text-muted-foreground"
        title={show === "run" ? runHint : metricHint}
      >
        {show === "run" ? runHint : metricHint}
      </code>

      <div id={PANEL_ID} className="space-y-2">
        <div hidden={show !== "run"} aria-label={runLabel}>
          <CodeEditor
            value={runCode}
            onChange={onRunCodeChange}
            height={EDITOR_HEIGHT}
            streaming={agent.signatureStatus === "writing"}
            flashLines={agent.signatureFlashLines}
          />
        </div>
        <div hidden={show !== "metric"} aria-label={metricLabel} className="space-y-2">
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
        </div>
      </div>
    </div>
  );
}
