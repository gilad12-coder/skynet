"use client";

import { withScorerImports } from "../../lib/scorer-dependencies";

import { LazyCodeEditor as CodeEditor } from "@/shared/ui/lazy-code-editor";

import { useEffect, useState } from "react";
import { CheckCircle, CircleNotch, Play, XCircle } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import { Input } from "@/shared/ui/primitives/input";
import { Label } from "@/shared/ui/primitives/label";
import { HelpTip } from "@/shared/ui/help-tip";
import { ModelChip } from "@/shared/ui/model-chip";
import { formatMsg, msg } from "@/shared/lib/messages";
import { tip } from "@/shared/lib/tooltips";
import { formatElapsedMs, formatScore } from "@/shared/lib/formatters";

import type { BlackboxWizardContext } from "../../hooks/use-blackbox-wizard";
import { ArtifactStatusChip } from "../steps/AuthoringShell";
import { VersionStepper } from "../steps/CodeAgentPanel";
import { BlackboxAuthoringShell } from "./BlackboxAuthoringShell";
import { Disclosure } from "../Disclosure";
import { emptyModelConfig } from "../../constants";
import { EvidenceChip } from "./EvidenceChip";
import { Field, MOBILE_INPUT_CLASS, Segmented } from "./shared";

const MOBILE_MODEL_CHIP_CLASS =
  "min-h-[44px] max-lg:[&_button]:min-h-[44px] max-lg:[&_button]:min-w-[44px] max-lg:[&_button]:opacity-100";

function isDataImage(entry: [string, unknown]): entry is [string, string] {
  return typeof entry[1] === "string" && entry[1].startsWith("data:image/");
}

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
    scorerInstall,
    setScorerInstall,
    scorerModel,
    setScorerModel,
    scorerModelMode,
    setScorerModelMode,
    resolvedScorerModel,
    scoringModelPending,
    reflectionModel,
    scorerUsesModel,
    evaluatorEvidence,
    evaluatorStatus,
    setEditingModel,
    catalog,
    dryRun,
    runDryRun,
  } = w;

  // Most scorers need nothing installed, so the command folds away until
  // one is set (a clone, a returning draft, the agent).
  const hasInstall = scorerInstall.trim() !== "";
  const [installOpen, setInstallOpen] = useState(hasInstall);
  useEffect(() => {
    if (hasInstall) setInstallOpen(true);
  }, [hasInstall]);

  const result = dryRun.status === "done" ? dryRun.result : null;
  const sideEntries = result?.ok ? Object.entries(result.side_info) : [];
  const sideImages = sideEntries.filter(isDataImage);
  const sideText = Object.fromEntries(sideEntries.filter((entry) => !isDataImage(entry)));

  return (
    <BlackboxAuthoringShell
      w={w}
      title={msg("submit.blackbox.scorer.title")}
      description={msg("submit.blackbox.scorer.desc")}
    >
      <Segmented<"python" | "remote">
        label={msg("submit.blackbox.scorer.title")}
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
          {scorerUsesModel && (
            <div
              id="bb-scoring-model"
              tabIndex={-1}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border/50 bg-muted/20 p-3 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {/* Inheriting shows the optimization model itself; picking a
                  different one is one click on the chip. Removing it clears
                  the evaluator model until another is selected. */}
              <ModelChip
                roleLabel={msg("submit.blackbox.roles.scoring.label")}
                showDetails={false}
                config={
                  scorerModelMode === "explicit"
                    ? scorerModel
                    : (resolvedScorerModel ?? emptyModelConfig())
                }
                className={`w-full min-w-0 ${MOBILE_MODEL_CHIP_CLASS}`}
                tooltip={msg("submit.blackbox.scorer.model_explainer")}
                required
                emptyLabel={
                  scoringModelPending ? msg("submit.blackbox.roles.not_chosen") : undefined
                }
                catalogModels={catalog?.models}
                onClick={() =>
                  setEditingModel({
                    // Seeded from the model it replaces so a different scoring
                    // model starts one field away, not from blank.
                    config:
                      scorerModelMode === "explicit" || scorerModel.name
                        ? scorerModel
                        : { ...reflectionModel },
                    onSave: (config) => {
                      setScorerModel(config);
                      setScorerModelMode("explicit");
                    },
                    label: msg("submit.blackbox.roles.scoring.label"),
                  })
                }
                onRemove={
                  resolvedScorerModel?.name.trim() || scorerModel.name.trim()
                    ? () => {
                        setScorerModel(emptyModelConfig());
                        setScorerModelMode("explicit");
                      }
                    : undefined
                }
              />
              {!resolvedScorerModel?.name.trim() && (
                <p role="alert" className="w-full text-xs text-destructive">
                  {msg("submit.blackbox.validation.scorer_model_required")}
                </p>
              )}
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Label>
              <HelpTip text={tip("submit.blackbox.scorer_code")}>
                {msg("submit.blackbox.scorer.code_label")}
              </HelpTip>
            </Label>
            <div className="flex items-center gap-3">
              <EvidenceChip status={evaluatorStatus} modelName={evaluatorEvidence?.modelName} />
              {codeAssistMode === "auto" && (
                <div className="flex items-center gap-2">
                  <VersionStepper agent={agent} artifact="metric" />
                  <ArtifactStatusChip status={agent.metricStatus} />
                </div>
              )}
            </div>
          </div>
          <div
            id="bb-scorer-code"
            tabIndex={-1}
            className="outline-none"
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) {
                const code = withScorerImports(metricCode);
                if (code !== metricCode) setMetricCode(code);
              }
            }}
          >
            <CodeEditor
              value={metricCode}
              onChange={(v) => {
                setMetricCode(v);
                setScorerManuallyEdited(true);
              }}
              height="360px"
              onRun={runDryRun}
              runLabel={msg("submit.blackbox.scorer.test")}
              runningLabel={msg("submit.blackbox.scorer.testing")}
              validationResult={scorerValidation}
              streaming={codeAssistMode === "auto" && agent.metricStatus === "writing"}
              flashLines={codeAssistMode === "auto" ? agent.metricFlashLines : undefined}
            />
          </div>
          <Disclosure
            id="bb-scorer-install-panel"
            label={msg("submit.blackbox.scorer.install_toggle")}
            open={installOpen}
            onOpenChange={setInstallOpen}
          >
            <div className="pt-1">
              <Field
                label={msg("submit.blackbox.scorer.install_label")}
                htmlFor="bb-scorer-install"
                tip="submit.blackbox.scorer_install"
              >
                <Input
                  id="bb-scorer-install"
                  value={scorerInstall}
                  onChange={(e) => setScorerInstall(e.target.value)}
                  placeholder="pip install --no-index --find-links=/opt/skynet/wheels package-name"
                  dir="ltr"
                  className={`${MOBILE_INPUT_CLASS} font-mono`}
                />
              </Field>
            </div>
          </Disclosure>
        </div>
      ) : (
        <div className="space-y-4">
          <Field
            label={msg("submit.blackbox.scorer.url_label")}
            htmlFor="bb-scorer-url"
            tip="submit.blackbox.scorer_url"
            hint={`${msg("submit.blackbox.scorer.remote_hint")} ${msg("submit.budget.external_endpoint_fees")}`}
          >
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
            <Field
              label={msg("submit.blackbox.scorer.secret_label")}
              htmlFor="bb-scorer-secret"
              tip="submit.blackbox.scorer_secret"
            >
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
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => void runDryRun()}
              disabled={dryRun.status === "running"}
              className="min-h-[44px] w-full gap-2 lg:min-h-0"
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
            <EvidenceChip status={evaluatorStatus} />
          </div>
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
          {sideImages.length > 0 && (
            <div className="flex flex-wrap gap-2" dir="ltr">
              {sideImages.map(([key, url]) => (
                // Renders arrive as data URLs the scorer built; a plain <img>
                // shows them without a next/image loader round-trip.
                <img
                  key={key}
                  src={url}
                  alt={key}
                  title={key}
                  className="h-24 w-auto rounded border border-border/60 bg-white object-contain"
                />
              ))}
            </div>
          )}
          {Object.keys(sideText).length > 0 && (
            <pre
              className="max-h-40 overflow-auto rounded-md border border-[#E5DDD4]/60 bg-[#FAF6F0] p-2 font-mono text-[0.6875rem] leading-relaxed text-[#3D2E22]/80"
              dir="ltr"
            >
              {JSON.stringify(sideText, null, 2)}
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
