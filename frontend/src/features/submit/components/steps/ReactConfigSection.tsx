"use client";

import * as React from "react";
import { Warning, CheckCircle, CircleNotch } from "@/shared/ui/icons";

import { Label } from "@/shared/ui/primitives/label";
import { Input } from "@/shared/ui/primitives/input";
import { HelpTip } from "@/shared/ui/help-tip";
import { RetryIconButton } from "@/shared/ui/retry-icon-button";
import { cn } from "@/shared/lib/utils";
import { tip } from "@/shared/lib/tooltips";
import { formatMsg, msg } from "@/shared/lib/messages";
import { probeMcp, type McpProbeTool } from "@/shared/lib/api";

import type { SubmitWizardContext } from "../../hooks/use-submit-wizard";
import {
  initializeToolFilter,
  missingToolNames,
  selectAllAvailableTools,
  selectedToolNames,
  toggleToolSelection,
  uniqueToolNames,
} from "../../lib/react-tool-filter";

type ProbeStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "ok"; toolCount: number; tools: McpProbeTool[] }
  | { kind: "error"; detail: string };

// How long the URL/auth fields must sit still before the connection check
// fires — long enough to skip mid-typing states, short enough to feel live.
const PROBE_DEBOUNCE_MS = 700;

export function ReactConfigSection({ w }: { w: SubmitWizardContext }) {
  const { reactConfig, updateReactConfig } = w;
  const [probe, setProbe] = React.useState<ProbeStatus>({ kind: "idle" });
  // Monotonic sequence so a slow response for an old URL can't overwrite the
  // status of the current one.
  const probeSeqRef = React.useRef(0);
  const toolFilterRef = React.useRef(reactConfig.toolFilter);
  const rosterId = React.useId();

  React.useEffect(() => {
    toolFilterRef.current = reactConfig.toolFilter;
  }, [reactConfig.toolFilter]);

  const runProbe = React.useCallback(
    (url: string, auth: string) => {
      const seq = ++probeSeqRef.current;
      setProbe({ kind: "checking" });
      probeMcp({ mcp_url: url, ...(auth.trim() ? { auth_header: auth.trim() } : {}) })
        .then((res) => {
          if (probeSeqRef.current !== seq) return;
          if (!res.ok) {
            setProbe({ kind: "error", detail: res.error ?? "" });
            return;
          }
          setProbe({ kind: "ok", toolCount: res.tool_count, tools: res.tools });
          const initialized = initializeToolFilter(toolFilterRef.current, res.tools);
          if (toolFilterRef.current === undefined && initialized !== undefined) {
            toolFilterRef.current = initialized;
            updateReactConfig({ toolFilter: initialized });
          }
        })
        .catch((err: unknown) => {
          if (probeSeqRef.current !== seq) return;
          setProbe({ kind: "error", detail: err instanceof Error ? err.message : String(err) });
        });
    },
    [updateReactConfig],
  );

  React.useEffect(() => {
    // Invalidate an in-flight response immediately when either credential field
    // changes, including during the debounce window.
    probeSeqRef.current++;
    const url = reactConfig.mcpUrl.trim();
    if (!url) {
      setProbe({ kind: "idle" });
      return;
    }
    setProbe({ kind: "checking" });
    const t = window.setTimeout(() => runProbe(url, reactConfig.mcpAuthHeader), PROBE_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [reactConfig.mcpUrl, reactConfig.mcpAuthHeader, runProbe]);

  const tools = probe.kind === "ok" ? probe.tools : [];
  const toolsByName = new Map<string, McpProbeTool>();
  for (const tool of tools) {
    if (!toolsByName.has(tool.name)) toolsByName.set(tool.name, tool);
  }
  const advertisedNames = uniqueToolNames(tools);
  const missingNames = missingToolNames(reactConfig.toolFilter, tools);
  const displayedTools = [
    ...advertisedNames.map((name) => ({ ...toolsByName.get(name)!, missing: false })),
    ...missingNames.map((name) => ({ name, description: null, missing: true })),
  ];
  const selected = new Set(selectedToolNames(reactConfig.toolFilter, tools));
  const allAvailableSelected =
    advertisedNames.length > 0 && advertisedNames.every((name) => selected.has(name));

  return (
    <div
      className="space-y-5 rounded-xl border border-border/60 bg-muted/20 p-4"
      data-tutorial="react-config"
    >
      <div className="space-y-1">
        <Label className="font-semibold">
          <HelpTip text={tip("submit.react_section")}>{msg("submit.react.section_title")}</HelpTip>
        </Label>
      </div>

      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">
          {msg("submit.budget.external_endpoint_fees")}
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs">
              <HelpTip text={tip("react.mcp_url")}>{msg("submit.react.mcp_url_label")}</HelpTip>
            </Label>
            <Input
              value={reactConfig.mcpUrl}
              dir="ltr"
              placeholder="http://localhost:8000/mcp/"
              className="h-[44px] font-mono text-base lg:h-9 lg:text-xs"
              onChange={(e) => updateReactConfig({ mcpUrl: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">
              <HelpTip text={tip("react.auth")}>{msg("submit.react.auth_label")}</HelpTip>
            </Label>
            <Input
              type="password"
              value={reactConfig.mcpAuthHeader}
              dir="ltr"
              autoComplete="off"
              placeholder="Bearer …"
              className="h-[44px] font-mono text-base lg:h-9 lg:text-xs"
              onChange={(e) => updateReactConfig({ mcpAuthHeader: e.target.value })}
            />
          </div>
        </div>

        {probe.kind !== "idle" && (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div
                className={cn(
                  "flex min-w-0 items-center gap-1.5 text-[0.6875rem] font-medium",
                  probe.kind === "checking" && "text-muted-foreground",
                  probe.kind === "ok" && "text-[#5A7247]",
                  probe.kind === "error" && "text-[#A3512B]",
                )}
                aria-live="polite"
              >
                {probe.kind === "checking" && (
                  <>
                    <CircleNotch className="size-3 shrink-0 animate-spin" />
                    {msg("submit.react.mcp_checking")}
                  </>
                )}
                {probe.kind === "ok" && (
                  <>
                    <CheckCircle className="size-3 shrink-0" />
                    {formatMsg("submit.react.mcp_connected", { p1: probe.toolCount })}
                  </>
                )}
                {probe.kind === "error" && (
                  <>
                    <Warning className="size-3 shrink-0" />
                    {msg("submit.react.mcp_failed")}
                  </>
                )}
              </div>
              {probe.kind === "error" && (
                <RetryIconButton
                  label={msg("submit.react.mcp_retry")}
                  onClick={() => runProbe(reactConfig.mcpUrl.trim(), reactConfig.mcpAuthHeader)}
                  className="size-[44px] lg:size-8"
                />
              )}
            </div>
            {probe.kind === "ok" && (
              <fieldset className="overflow-hidden rounded-lg border border-border/60 bg-background/80">
                <legend className="sr-only">{msg("submit.react.tools_list_label")}</legend>
                <div className="flex flex-wrap items-start justify-between gap-2 border-b border-border/50 px-3 py-2.5">
                  <div className="min-w-0 space-y-0.5">
                    <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
                      {msg("submit.react.tools_permissions_help")}
                    </p>
                    <p className="text-[0.625rem] font-semibold text-foreground tabular-nums">
                      {formatMsg("submit.react.tools_selected", {
                        p1: selected.size,
                        p2: displayedTools.length,
                      })}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={advertisedNames.length === 0 || allAvailableSelected}
                    onClick={() =>
                      updateReactConfig({
                        toolFilter: selectAllAvailableTools(reactConfig.toolFilter, tools),
                      })
                    }
                    className="min-h-9 shrink-0 cursor-pointer rounded-md border border-[#C8A882]/55 bg-[#C8A882]/10 px-2.5 text-[0.6875rem] font-semibold text-foreground transition-colors hover:bg-[#C8A882]/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C8A882]/45 disabled:pointer-events-none disabled:opacity-45"
                  >
                    {msg("submit.react.tools_select_all")}
                  </button>
                </div>

                {reactConfig.toolFilter === null && (
                  <p className="border-b border-border/40 bg-[#C8A882]/8 px-3 py-2 text-[0.625rem] leading-relaxed text-muted-foreground">
                    {msg("submit.react.tools_full_roster")}
                  </p>
                )}

                {displayedTools.length > 0 ? (
                  <ul className="max-h-64 divide-y divide-border/40 overflow-y-auto">
                    {displayedTools.map((tool, index) => {
                      const checked = selected.has(tool.name);
                      const lastSelected = checked && selected.size <= 1;
                      const descriptionId = `${rosterId}-${index}-description`;
                      return (
                        <li key={`${tool.missing ? "missing" : "available"}:${tool.name}`}>
                          <label
                            className={cn(
                              "flex min-h-[44px] cursor-pointer items-start gap-2.5 px-3 py-2.5 transition-colors hover:bg-muted/40",
                              tool.missing && "bg-[#B76B3D]/8",
                              lastSelected && "cursor-not-allowed",
                            )}
                            dir="ltr"
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={lastSelected}
                              aria-describedby={descriptionId}
                              onChange={() =>
                                updateReactConfig({
                                  toolFilter: toggleToolSelection(
                                    reactConfig.toolFilter,
                                    tools,
                                    tool.name,
                                  ),
                                })
                              }
                              className="mt-0.5 size-4 shrink-0 cursor-pointer accent-[#8A6D44] disabled:cursor-not-allowed"
                            />
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-1.5 font-mono text-[0.6875rem] leading-tight font-semibold break-all text-foreground">
                                {tool.missing && (
                                  <Warning
                                    className="size-3 shrink-0 text-[#A3512B]"
                                    aria-hidden="true"
                                  />
                                )}
                                {tool.name}
                              </span>
                              <span
                                id={descriptionId}
                                className={cn(
                                  "mt-1 block text-[0.6875rem] leading-relaxed break-words whitespace-pre-line text-muted-foreground",
                                  tool.missing && "text-[#8B4A2C]",
                                )}
                              >
                                {tool.missing
                                  ? msg("submit.react.tool_missing")
                                  : (tool.description ?? msg("submit.react.tool_no_description"))}
                              </span>
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="px-3 py-4 text-[0.6875rem] text-muted-foreground">
                    {msg("submit.react.tools_empty")}
                  </p>
                )}
                <p className="border-t border-border/40 px-3 py-2 text-[0.625rem] text-muted-foreground">
                  {msg("submit.react.tools_keep_one")}
                </p>
              </fieldset>
            )}
            {probe.kind === "error" && probe.detail && (
              <p
                className="break-words font-mono text-[0.625rem] leading-relaxed text-muted-foreground"
                dir="ltr"
              >
                {probe.detail}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
