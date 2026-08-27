"use client";

import dynamic from "next/dynamic";
import { CheckCircle, CircleNotch, Play, XCircle } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import { Input } from "@/shared/ui/primitives/input";
import { NumberInput } from "@/shared/ui/number-input";
import { formatMsg, msg } from "@/shared/lib/messages";

import type { BlackboxWizardContext } from "../../hooks/use-blackbox-wizard";
import {
  Field,
  MOBILE_INPUT_CLASS,
  MOBILE_NUMBER_INPUT_CLASS,
  Segmented,
  StepCard,
} from "./shared";

const CodeEditor = dynamic(() => import("@/shared/ui/code-editor").then((m) => m.CodeEditor), {
  ssr: false,
});

export function BlackboxScorerStep({ w }: { w: BlackboxWizardContext }) {
  const {
    scorerKind,
    setScorerKind,
    metricCode,
    setMetricCode,
    scorerUrl,
    setScorerUrl,
    scorerSecret,
    setScorerSecret,
    scorerTimeout,
    setScorerTimeout,
    dryRun,
    runDryRun,
  } = w;

  const result = dryRun.status === "done" ? dryRun.result : null;
  const sideInfo = result?.ok && Object.keys(result.side_info).length > 0 ? result.side_info : null;

  return (
    <StepCard
      title={msg("submit.blackbox.scorer.title")}
      description={msg("submit.blackbox.scorer.desc")}
    >
      <Segmented<"python" | "remote">
        value={scorerKind}
        onChange={setScorerKind}
        options={[
          {
            value: "python",
            label: msg("submit.blackbox.scorer.kind.python"),
            desc: msg("submit.blackbox.scorer.kind.python_desc"),
          },
          {
            value: "remote",
            label: msg("submit.blackbox.scorer.kind.remote"),
            desc: msg("submit.blackbox.scorer.kind.remote_desc"),
          },
        ]}
      />

      {scorerKind === "python" ? (
        <div className="space-y-2">
          <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
            {msg("submit.blackbox.scorer.code_hint")}
          </p>
          <CodeEditor
            value={metricCode}
            onChange={setMetricCode}
            height="260px"
            onRun={runDryRun}
            runLabel={msg("submit.blackbox.scorer.test")}
            runningLabel={msg("submit.blackbox.scorer.testing")}
          />
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-[0.6875rem] leading-relaxed text-muted-foreground" dir="ltr">
            {msg("submit.blackbox.scorer.remote_hint")}
          </p>
          <Field label={msg("submit.blackbox.scorer.url_label")} htmlFor="bb-scorer-url">
            <Input
              id="bb-scorer-url"
              type="url"
              value={scorerUrl}
              onChange={(e) => setScorerUrl(e.target.value)}
              placeholder="https://example.com/score"
              dir="ltr"
              className={`${MOBILE_INPUT_CLASS} font-mono`}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
            <Field label={msg("submit.blackbox.scorer.secret_label")} htmlFor="bb-scorer-secret">
              <Input
                id="bb-scorer-secret"
                type="password"
                autoComplete="off"
                value={scorerSecret}
                onChange={(e) => setScorerSecret(e.target.value)}
                dir="ltr"
                className={`${MOBILE_INPUT_CLASS} font-mono`}
              />
            </Field>
            <Field label={msg("submit.blackbox.scorer.timeout_label")} htmlFor="bb-scorer-timeout">
              <NumberInput
                id="bb-scorer-timeout"
                value={scorerTimeout}
                onChange={setScorerTimeout}
                min={1}
                max={600}
                step={5}
                className={MOBILE_NUMBER_INPUT_CLASS}
              />
            </Field>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => void runDryRun()}
            disabled={dryRun.status === "running"}
            className="min-h-[44px] gap-2 lg:min-h-0"
          >
            {dryRun.status === "running" ? (
              <CircleNotch className="size-4 animate-spin" />
            ) : (
              <Play className="size-4" />
            )}
            {msg(
              dryRun.status === "running"
                ? "submit.blackbox.scorer.testing"
                : "submit.blackbox.scorer.test",
            )}
          </Button>
        </div>
      )}

      {result?.ok && (
        <div className="space-y-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-800">
          <div className="flex items-center gap-2">
            <CheckCircle className="size-4 shrink-0" />
            <span>
              {formatMsg("submit.blackbox.scorer.result_ok", {
                score: result.score ?? "—",
                ms: result.elapsed_ms,
              })}
            </span>
          </div>
          {sideInfo && (
            <pre
              className="max-h-40 overflow-auto rounded bg-background/60 p-2 text-[0.6875rem] text-foreground/80"
              dir="ltr"
            >
              {JSON.stringify(sideInfo, null, 2)}
            </pre>
          )}
        </div>
      )}
      {result && !result.ok && scorerKind === "remote" && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <XCircle className="mt-0.5 size-4 shrink-0" />
          <span className="break-words" dir="auto">
            {result.error ?? msg("submit.blackbox.scorer.result_error")}
          </span>
        </div>
      )}
    </StepCard>
  );
}
