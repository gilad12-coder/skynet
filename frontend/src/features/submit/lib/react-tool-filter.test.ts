import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildLiveMcpToolSource,
  initializeToolFilter,
  missingToolNames,
  selectAllAvailableTools,
  selectedToolNames,
  toggleToolSelection,
} from "./react-tool-filter.ts";

const tools = [{ name: "lookup" }, { name: "search" }];

test("a fresh successful probe selects the exact advertised roster once", () => {
  assert.deepEqual(initializeToolFilter(undefined, tools), ["lookup", "search"]);
  assert.deepEqual(initializeToolFilter(["lookup"], tools), ["lookup"]);
  assert.equal(initializeToolFilter(null, tools), null);
  assert.deepEqual(initializeToolFilter(undefined, []), []);
});

test("legacy full-roster and explicit selections remain distinct", () => {
  assert.deepEqual(selectedToolNames(null, tools), ["lookup", "search"]);
  assert.deepEqual(selectedToolNames(["lookup"], tools), ["lookup"]);
  assert.deepEqual(missingToolNames(["lookup", "removed"], tools), ["removed"]);
  assert.deepEqual(missingToolNames(null, tools), []);
});

test("tool toggles never widen a restored filter or create an empty filter", () => {
  assert.deepEqual(toggleToolSelection(["lookup", "removed"], tools, "lookup"), ["removed"]);
  assert.deepEqual(toggleToolSelection(["removed"], tools, "removed"), ["removed"]);
  assert.deepEqual(toggleToolSelection(["removed"], tools, "search"), ["removed", "search"]);
  assert.deepEqual(selectAllAvailableTools(["removed"], tools), ["removed", "lookup", "search"]);
  assert.equal(selectAllAvailableTools(null, tools), null);
});

test("wire serialization sends an exact filter and omits one before the first probe", () => {
  assert.deepEqual(
    buildLiveMcpToolSource({
      mcpUrl: " https://tools.example.test/mcp ",
      mcpAuthHeader: " Bearer one-time-secret ",
      toolFilter: ["lookup"],
    }),
    {
      kind: "live_mcp",
      mcp_url: "https://tools.example.test/mcp",
      mcp_auth_header: "Bearer one-time-secret",
      tool_filter: ["lookup"],
    },
  );
  assert.deepEqual(buildLiveMcpToolSource({ mcpUrl: "", mcpAuthHeader: "" }), {
    kind: "live_mcp",
  });
  assert.deepEqual(
    buildLiveMcpToolSource({ mcpUrl: "https://tools.test", mcpAuthHeader: "", toolFilter: null }),
    { kind: "live_mcp", mcp_url: "https://tools.test", tool_filter: null },
  );
});
