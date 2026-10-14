"use client";

import { InlineErrorRow } from "@/shared/ui/inline-error-row";
import * as React from "react";
import dynamic from "next/dynamic";
import { CheckCircle, CircleNotch, Sparkle, WarningCircle } from "@/shared/ui/icons";
import { msg } from "@/shared/lib/messages";

import { cn } from "@/shared/lib/utils";
import { IndexPager } from "@/shared/ui/index-pager";
import { Skeleton } from "@/shared/ui/skeleton";
import { LazyCodeEditor } from "@/shared/ui/lazy-code-editor";
import { ActivityBreadcrumb } from "@/shared/ui/agent/activity-breadcrumb";
import { ChatErrorBanner } from "@/shared/ui/agent/chat-error-banner";
import { ThinkingSection } from "@/shared/ui/agent/thinking-section";
import { getActiveDir } from "@/shared/lib/runtime-locale";
import type { ValidateCodeResponse } from "@/shared/types/api";

import type {
  AuthoringCheckStatus,
  CodeAuthoringAgentState,
} from "../hooks/use-code-authoring-agent";

// The same react-flow canvas the /submit wizard uses, mounted inline so a
// workflow (multi-module) run can be authored and edited without leaving chat.
const WorkflowCanvas = dynamic(
  () => import("@/features/submit/workflow/WorkflowCanvas").then((m) => m.WorkflowCanvas),
  { ssr: false, loading: () => <Skeleton height={420} borderRadius={8} /> },
);

interface CodeAuthoringCardProps {
  /** Lifted code-agent state, owned by the panel so it survives collapse. */
  agent: CodeAuthoringAgentState;
}

/**
 * The coding tool's card, shown in the generalist chat when the agent calls
 * ``request_code_authoring``: the thinking timer, the reading→run code→metric
 * breadcrumb, the run code and metric streaming into editors the user can
 * edit, and the validity check's result. On the submit wizard the editors hold
 * the wizard's own code, so an edit here shows in the Metric step and back.
 * A workflow run shows its canvas in place of the run code.
 */
export function CodeAuthoringCard({ agent }: CodeAuthoringCardProps) {
  const streaming = agent.status === "streaming";
  const authored = agent.isWorkflow ? !!agent.workflowSpec : !!agent.signatureCode;
  const hasOutput = streaming || authored || !!agent.metricCode || !!agent.reasoning;
  const hasError = agent.status === "error" && !!agent.error;

  // A run that fails before emitting any reasoning or code — e.g. an upstream
  // rate-limit on the first token — would otherwise fall through to the neutral
  // hint below and swallow the reason. Surface the error itself so the user can
  // act (retry, or pick a different model in the composer).
  if (hasError && !hasOutput) {
    return <ChatErrorBanner message={agent.error} />;
  }

  // Before the seed starts (or on a reopened historical conversation where the
  // run state was cleared) there is nothing to mirror — show the neutral hint.
  if (!hasOutput) {
    return (
      <div className="rounded-2xl border border-border/50 bg-card/70 px-4 py-3 text-[0.75rem] text-muted-foreground">
        {msg("auto.features.submit.components.steps.codeagentpanel.literal.16")}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-primary-fill/30 bg-background">
      <div className="flex items-center gap-2 border-b border-primary-fill/10 px-4 py-2.5 text-[0.8125rem] font-medium text-primary">
        <Sparkle className="size-3.5 text-primary" aria-hidden="true" />
        {msg("auto.features.submit.components.steps.codestep.1")}
      </div>

      <ThinkingSection
        thinking={{
          reasoning: agent.reasoning,
          startedAt: agent.reasoningStartedAt,
          endedAt: agent.reasoningEndedAt,
          streaming,
        }}
      />

      {streaming && agent.mode === "seed" && !agent.isWorkflow && (
        <div className="flex justify-center px-4 py-3">
          <ActivityBreadcrumb
            signatureStatus={agent.signatureStatus}
            metricStatus={agent.metricStatus}
          />
        </div>
      )}

      <div dir="ltr" className="space-y-3 px-4 pb-4 pt-3">
        {agent.isWorkflow ? (
          agent.workflowSpec && (
            <div className="h-[min(440px,60dvh)] overflow-hidden rounded-lg border border-border/40 sm:h-[440px]">
              <WorkflowCanvas
                spec={agent.workflowSpec}
                specRevision={agent.workflowRevision}
                onSpecChange={agent.updateWorkflowSpec}
                pulseNodeId={agent.agentPulseNodeId}
              />
            </div>
          )
        ) : (
          <ArtifactBlock
            label={msg("submit.v2.metric.run_label")}
            code={agent.signatureCode}
            onChange={agent.editSignatureCode}
            streaming={agent.signatureStatus === "writing"}
            validationResult={agent.signatureValidation}
            flashLines={agent.signatureFlashLines}
            pager={
              <VersionPager
                index={agent.signatureVersionIndex}
                total={agent.signatureVersions.length}
                onChange={agent.goToSignatureVersion}
              />
            }
          />
        )}
        <ArtifactBlock
          label={msg("submit.v2.metric.metric_label")}
          code={agent.metricCode}
          onChange={agent.editMetricCode}
          streaming={agent.metricStatus === "writing"}
          validationResult={agent.metricValidation}
          flashLines={agent.metricFlashLines}
          pager={
            <VersionPager
              index={agent.metricVersionIndex}
              total={agent.metricVersions.length}
              onChange={agent.goToMetricVersion}
            />
          }
        />
        {!agent.isWorkflow && <CheckStatusRow status={agent.checkStatus} />}
      </div>

      {agent.error && <InlineErrorRow message={agent.error} className="m-3 py-2" />}
    </div>
  );
}

const CHECK_STATUS = {
  checking: {
    icon: CircleNotch,
    key: "agent.coding_tool.check.checking",
    className: "text-muted-foreground",
  },
  passed: {
    icon: CheckCircle,
    key: "agent.coding_tool.check.passed",
    className: "text-[#5A7247] dark:text-[#adc899]",
  },
  failed: {
    icon: WarningCircle,
    key: "agent.coding_tool.check.failed",
    className: "text-destructive",
  },
} as const;

/** The validity check's verdict on the code in the editors above. */
function CheckStatusRow({ status }: { status: AuthoringCheckStatus }) {
  if (status === "idle") return null;
  const { icon: Icon, key, className } = CHECK_STATUS[status];
  return (
    <p
      role="status"
      dir={getActiveDir()}
      className={cn("flex items-center gap-1.5 text-[0.75rem]", className)}
    >
      <Icon
        className={cn("size-3.5 shrink-0", status === "checking" && "animate-spin")}
        aria-hidden="true"
      />
      {msg(key)}
    </p>
  );
}

function VersionPager({
  index,
  total,
  onChange,
}: {
  index: number;
  total: number;
  onChange: (index: number) => void;
}) {
  return (
    <IndexPager
      currentIndex={index}
      total={total}
      onChange={onChange}
      prevLabel={msg("auto.features.submit.components.steps.codeagentpanel.literal.6")}
      nextLabel={msg("auto.features.submit.components.steps.codeagentpanel.literal.7")}
    />
  );
}

function ArtifactBlock({
  label,
  code,
  onChange,
  streaming,
  validationResult,
  flashLines,
  pager,
}: {
  label: string;
  code: string;
  onChange: (code: string) => void;
  streaming: boolean;
  validationResult: ValidateCodeResponse | null;
  flashLines: number[];
  pager: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2" dir={getActiveDir()}>
        <span
          className={cn(
            "text-[0.6875rem] font-semibold uppercase tracking-widest text-muted-foreground",
            streaming && "text-primary",
          )}
        >
          {label}
        </span>
        {pager}
      </div>
      <LazyCodeEditor
        value={code}
        onChange={onChange}
        height="180px"
        readOnly={streaming}
        streaming={streaming}
        validationResult={validationResult}
        flashLines={flashLines}
      />
    </div>
  );
}
