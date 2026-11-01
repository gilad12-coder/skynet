import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { MCP_NOT_LIVE_NOTE, MCP_SERVER_URL } from "../../../shared/lib/mcp-clients.ts";

// Until pull request #861 deploys, every text that names the MCP server URL
// must also say that the server is not live yet.

test("every docs page that names the MCP server says it is not live yet", () => {
  const root = new URL("../content/", import.meta.url);
  const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".md"));
  const named = files.filter((f) => readFileSync(new URL(f, root), "utf8").includes(MCP_SERVER_URL));
  assert.ok(named.length >= 4, "the MCP and FAQ pages in both languages name the server");
  for (const file of named) {
    assert.match(readFileSync(new URL(file, root), "utf8"), /#861/, `${file} names the MCP server without the not-live note`);
  }
});

test("llms.txt names the MCP server together with the not-live note", () => {
  assert.match(MCP_NOT_LIVE_NOTE, /not live yet.*#861/);
  const route = readFileSync(new URL("../../../app/llms.txt/route.ts", import.meta.url), "utf8");
  assert.match(route, /\$\{MCP_SERVER_URL\}\. \$\{MCP_NOT_LIVE_NOTE\}/);
});
