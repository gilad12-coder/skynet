import type { ToolSource } from "@/shared/types/api";

import type { ReactConfig } from "../constants";

export interface NamedMcpTool {
  name: string;
}

/** Return non-empty tool names once, in the endpoint's advertised order. */
export function uniqueToolNames(tools: readonly NamedMcpTool[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const tool of tools) {
    const name = tool.name;
    if (!name.trim() || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/** Select a fresh endpoint's first advertised roster without changing restored permissions. */
export function initializeToolFilter(
  current: ReactConfig["toolFilter"],
  tools: readonly NamedMcpTool[],
): ReactConfig["toolFilter"] {
  if (current !== undefined) return current;
  const names = uniqueToolNames(tools);
  return names;
}

/** Return the names currently selected for the visible endpoint roster. */
export function selectedToolNames(
  filter: ReactConfig["toolFilter"],
  tools: readonly NamedMcpTool[],
): string[] {
  return filter == null
    ? uniqueToolNames(tools)
    : uniqueToolNames(filter.map((name) => ({ name })));
}

/** Return explicit selections the endpoint no longer advertises. */
export function missingToolNames(
  filter: ReactConfig["toolFilter"],
  tools: readonly NamedMcpTool[],
): string[] {
  if (!Array.isArray(filter)) return [];
  const available = new Set(uniqueToolNames(tools));
  return uniqueToolNames(filter.map((name) => ({ name }))).filter((name) => !available.has(name));
}

/** Toggle one tool while refusing an empty allow-list, which older runtimes read as all tools. */
export function toggleToolSelection(
  filter: ReactConfig["toolFilter"],
  tools: readonly NamedMcpTool[],
  name: string,
): string[] | null | undefined {
  const selected = selectedToolNames(filter, tools);
  if (selected.includes(name)) {
    if (selected.length <= 1) return filter;
    return selected.filter((candidate) => candidate !== name);
  }
  return [...selected, name];
}

/** Add every currently advertised tool without dropping restored missing selections. */
export function selectAllAvailableTools(
  filter: ReactConfig["toolFilter"],
  tools: readonly NamedMcpTool[],
): string[] | null | undefined {
  if (filter === null) return null;
  const selected = selectedToolNames(filter, tools);
  const seen = new Set(selected);
  return [...selected, ...uniqueToolNames(tools).filter((name) => !seen.has(name))];
}

/** Build the live MCP wire model while keeping a fresh filter omitted and legacy null explicit. */
export function buildLiveMcpToolSource(config: ReactConfig): ToolSource {
  return {
    kind: "live_mcp",
    ...(config.mcpUrl.trim() ? { mcp_url: config.mcpUrl.trim() } : {}),
    ...(config.mcpAuthHeader.trim() ? { mcp_auth_header: config.mcpAuthHeader.trim() } : {}),
    ...(config.toolFilter !== undefined ? { tool_filter: config.toolFilter } : {}),
  };
}
