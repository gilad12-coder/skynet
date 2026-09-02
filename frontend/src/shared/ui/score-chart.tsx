"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { formatMsg, msg } from "@/shared/lib/messages";
import { detectRenderKind, RENDER_KIND_LABEL } from "@/shared/lib/candidate-render";
import { useLiteMode } from "@/features/settings";
import { ChartTable } from "@/shared/charts/chart-table";
import { getActiveDir } from "@/shared/lib/runtime-locale";

/**
 * What one step along the x-axis is: the prompt (DSPy runs), one named file,
 * one text whose render kind names it, or a bare version when nothing fits.
 */
export type ScoreChartArtifact =
  | { kind: "prompt" }
  | { kind: "version" }
  | { kind: "file"; name: string }
  | { kind: "text"; text: string };

const PROMPT: ScoreChartArtifact = { kind: "prompt" };

function formatScore(value: unknown): string {
  return typeof value === "number" ? value.toFixed(1) : "—";
}

function artifactName(artifact: ScoreChartArtifact): string | null {
  if (artifact.kind === "file") return artifact.name;
  if (artifact.kind !== "text") return null;
  const render = detectRenderKind(artifact.text);
  // "Python version 12" reads as the interpreter's version, so scripts take the code label.
  return msg(RENDER_KIND_LABEL[render === "python" ? "code" : render]);
}

function axisLabel(artifact: ScoreChartArtifact): string {
  if (artifact.kind === "prompt") return msg("shared.score_chart.prompt_version_axis");
  const name = artifactName(artifact);
  return name
    ? formatMsg("shared.score_chart.artifact_version_axis", { artifact: name })
    : msg("shared.score_chart.version_axis");
}

function pointLabel(artifact: ScoreChartArtifact, label: string): string {
  if (artifact.kind === "prompt") return formatMsg("shared.score_chart.prompt_version", { label });
  const name = artifactName(artifact);
  return name
    ? formatMsg("shared.score_chart.artifact_version", { artifact: name, label })
    : formatMsg("shared.score_chart.version", { label });
}

function ScoreChartTooltip({
  active,
  payload,
  label,
  artifact,
}: {
  active?: boolean;
  payload?: Array<{ value: number; name: string; color: string }>;
  label?: string;
  artifact: ScoreChartArtifact;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border bg-background p-3 shadow-md text-sm" dir={getActiveDir()}>
      <p className="font-medium mb-1.5">{pointLabel(artifact, label ?? "")}</p>
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="size-2.5 rounded-full shrink-0" style={{ backgroundColor: p.color }} />
          <span className="text-muted-foreground">{p.name}:</span>
          <span className="font-mono font-bold ms-auto" dir="ltr">
            {typeof p.value === "number" ? p.value.toFixed(1) : "—"}
          </span>
        </div>
      ))}
    </div>
  );
}

export function ScoreChart({
  data,
  artifact = PROMPT,
}: {
  data: Array<{ trial: number; score: number; best: number }>;
  artifact?: ScoreChartArtifact;
}) {
  const lite = useLiteMode();
  if (lite) {
    return (
      <ChartTable
        rows={data}
        columns={[
          { key: "trial", label: axisLabel(artifact) },
          {
            key: "score",
            label: msg("shared.score_chart.version_score"),
            align: "end",
            format: formatScore,
          },
          {
            key: "best",
            label: msg("shared.score_chart.best"),
            align: "end",
            format: formatScore,
          },
        ]}
      />
    );
  }
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 5, right: 10, left: 5, bottom: 18 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
        <XAxis
          dataKey="trial"
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 10 }}
          className="fill-muted-foreground"
          label={{
            value: axisLabel(artifact),
            position: "insideBottom",
            offset: -12,
            fontSize: 10,
            fill: "var(--muted-foreground)",
          }}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 10 }}
          className="fill-muted-foreground"
          label={{
            value: msg("shared.score_chart.score_axis"),
            angle: -90,
            position: "insideLeft",
            offset: 10,
            fontSize: 10,
            fill: "var(--muted-foreground)",
          }}
          domain={[0, "auto"]}
        />
        <Tooltip content={<ScoreChartTooltip artifact={artifact} />} />
        <Line
          type="monotone"
          dataKey="score"
          name={msg("shared.score_chart.version_score")}
          stroke="var(--color-chart-4)"
          strokeWidth={1.5}
          dot={{ r: 2 }}
          isAnimationActive={false}
        />
        <Line
          type="stepAfter"
          dataKey="best"
          name={msg("shared.score_chart.best")}
          stroke="var(--color-chart-2)"
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
