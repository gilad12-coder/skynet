"use client";

import dynamic from "next/dynamic";
import { CheckCircle, CircleNotch, Play, XCircle } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import { Input } from "@/shared/ui/primitives/input";
import { Label } from "@/shared/ui/primitives/label";
import { NumberInput } from "@/shared/ui/number-input";
import { ModelChip } from "@/shared/ui/model-chip";
import { formatMsg, msg } from "@/shared/lib/messages";
import { formatElapsedMs, formatScore } from "@/shared/lib/formatters";

import type { BlackboxWizardContext } from "../../hooks/use-blackbox-wizard";
import { SCORER_PRESETS } from "../../hooks/use-blackbox-wizard";
import { emptyModelConfig } from "../../constants";
import { ArtifactStatusChip } from "../steps/AuthoringShell";
import { VersionStepper } from "../steps/CodeAgentPanel";
import { BlackboxAuthoringShell } from "./BlackboxAuthoringShell";
import { Field, MOBILE_INPUT_CLASS, MOBILE_NUMBER_INPUT_CLASS, Segmented } from "./shared";

const MOBILE_MODEL_CHIP_CLASS =
  "min-h-[44px] max-lg:[&_button]:min-h-[44px] max-lg:[&_button]:min-w-[44px] max-lg:[&_button]:opacity-100";

const CodeEditor = dynamic(() => import("@/shared/ui/code-editor").then((m) => m.CodeEditor), {
  ssr: false,
});

export function BlackboxScorerStep({ w }: { w: BlackboxWizardContext }) {
  const {
    codeAssistMode,
    agent,
    scorerValidation,
    setScorerManuallyEdited,
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
    scorerModel,
    setScorerModel,
    setEditingModel,
    catalog,
    dryRun,
    runDryRun,
  } = w;

  const result = dryRun.status === "done" ? dryRun.result : null;
  const sideInfo = result?.ok && Object.keys(result.side_info).length > 0 ? result.side_info : null;

  return (
    <BlackboxAuthoringShell
      w={w}
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
        <div className="space-y-3">
          <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
            {msg("submit.blackbox.scorer.code_hint")}
          </p>
          <div className="space-y-2">
            <Label>{msg("submit.blackbox.scorer.preset_label")}</Label>
            <div className="flex flex-wrap gap-2">
              {SCORER_PRESETS.map((preset) => (
                <Button
                  key={preset.id}
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setMetricCode(preset.code);
                    setScorerManuallyEdited(true);
                  }}
                  className="min-h-[36px] text-xs"
                >
                  {msg(`submit.blackbox.scorer.preset.${preset.id}` as Parameters<typeof msg>[0])}
                </Button>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <Label>{msg("submit.blackbox.scorer.model_label")}</Label>
            <ModelChip
              config={scorerModel}
              className={MOBILE_MODEL_CHIP_CLASS}
              roleLabel={msg("submit.blackbox.scorer.model_label")}
              tooltip={msg("submit.blackbox.scorer.model_explainer")}
              catalogModels={catalog?.models}
              onClick={() =>
                setEditingModel({
                  config: scorerModel,
                  onSave: setScorerModel,
                  label: msg("submit.blackbox.scorer.model_label"),
                })
              }
              onRemove={scorerModel.name ? () => setScorerModel(emptyModelConfig()) : undefined}
            />
          </div>
          <Field
            label={msg("submit.blackbox.scorer.timeout_label")}
            htmlFor="bb-scorer-timeout"
            hint={msg("submit.blackbox.scorer.timeout_hint")}
          >
            <NumberInput
              id="bb-scorer-timeout"
              value={scorerTimeout}
              onChange={setScorerTimeout}
              min={1}
              max={600}
              step={5}
              className={`${MOBILE_NUMBER_INPUT_CLASS} sm:max-w-[14rem]`}
            />
          </Field>
          <div className="flex items-center justify-between gap-2">
            <Label>{msg("submit.blackbox.scorer.code_label")}</Label>
            {codeAssistMode === "auto" && (
              <div className="flex items-center gap-2">
                <VersionStepper agent={agent} artifact="metric" />
                <ArtifactStatusChip status={agent.metricStatus} />
              </div>
            )}
          </div>
          <CodeEditor
            value={metricCode}
            onChange={(v) => {
              setMetricCode(v);
              setScorerManuallyEdited(true);
            }}
            height="260px"
            onRun={runDryRun}
            runLabel={msg("submit.blackbox.scorer.test")}
            runningLabel={msg("submit.blackbox.scorer.testing")}
            validationResult={scorerValidation}
            streaming={codeAssistMode === "auto" && agent.metricStatus === "writing"}
            flashLines={codeAssistMode === "auto" ? agent.metricFlashLines : undefined}
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
        <div className="space-y-2 border-t border-border/60 pt-3" role="status">
          <div className="flex items-center gap-1.5 text-[0.6875rem] font-medium text-[#5A7247]">
            <CheckCircle className="size-3 shrink-0" />
            <span>{msg("submit.blackbox.scorer.result_ok")}</span>
          </div>
          <dl className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
            <div className="flex items-baseline gap-2">
              <dt className="text-[0.625rem] font-medium uppercase tracking-wide text-[#8C7A6B]">
                {msg("submit.blackbox.scorer.result_score")}
              </dt>
              <dd
                className="font-mono text-xs font-semibold tabular-nums text-[#3D2E22]"
                dir="ltr"
                title={result.score == null ? undefined : String(result.score)}
              >
                {formatScore(result.score)}
              </dd>
            </div>
            <div className="flex items-baseline gap-2">
              <dt className="text-[0.625rem] font-medium uppercase tracking-wide text-[#8C7A6B]">
                {msg("submit.blackbox.scorer.result_time")}
              </dt>
              <dd className="font-mono text-xs font-semibold tabular-nums text-[#3D2E22]" dir="ltr">
                {formatElapsedMs(result.elapsed_ms)}
              </dd>
            </div>
          </dl>
          {result.usage_by_model && result.usage_by_model.length > 0 && (
            <p className="text-[0.6875rem] text-[#8C7A6B]" dir="ltr">
              {formatMsg("submit.blackbox.scorer.result_usage", {
                usage: result.usage_by_model
                  .map((u) =>
                    formatMsg("submit.blackbox.scorer.result_usage_item", {
                      model: u.model,
                      tokens: u.input_tokens + u.output_tokens,
                    }),
                  )
                  .join(" · "),
              })}
            </p>
          )}
          {sideInfo && (
            <pre
              className="max-h-40 overflow-auto rounded-md border border-[#E5DDD4]/60 bg-[#FAF6F0] p-2 font-mono text-[0.6875rem] leading-relaxed text-[#3D2E22]/80"
              dir="ltr"
            >
              {JSON.stringify(sideInfo, null, 2)}
            </pre>
          )}
        </div>
      )}
      {result && !result.ok && scorerKind === "remote" && (
        <div className="space-y-1 border-t border-border/60 pt-3" role="alert">
          <div className="flex items-center gap-1.5 text-[0.6875rem] font-medium text-[#A3512B]">
            <XCircle className="size-3 shrink-0" />
            <span>{msg("submit.blackbox.scorer.result_error")}</span>
          </div>
          {result.error && (
            <p className="break-words text-xs text-foreground/80" dir="auto">
              {result.error}
            </p>
          )}
        </div>
      )}
    </BlackboxAuthoringShell>
  );
}
