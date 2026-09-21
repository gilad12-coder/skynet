/**
 * Pi extension that exposes the benchmark world's tools to the model.
 *
 * Pi has no MCP client, so this bridges the world's plain JSON API instead:
 * tool specs come from GET /__tools and calls go to POST /__call. The schemas
 * and results are the same ones the MCP harnesses see.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default async function (pi: ExtensionAPI) {
  const base = process.env.SKYNET_WORLD_URL;
  if (!base) throw new Error("SKYNET_WORLD_URL is not set");
  const specs = (await (await fetch(`${base}/__tools`)).json()) as Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
  for (const spec of specs) {
    pi.registerTool({
      name: spec.name,
      label: spec.name,
      description: spec.description,
      parameters: Type.Unsafe(spec.parameters),
      async execute(_toolCallId, params) {
        const response = await fetch(`${base}/__call`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tool: spec.name, args: params }),
        });
        const body = (await response.json()) as { ok: boolean; result?: unknown; error?: string };
        if (!body.ok) throw new Error(body.error ?? "tool failed");
        return { content: [{ type: "text", text: JSON.stringify(body.result) }], details: {} };
      },
    });
  }
}
