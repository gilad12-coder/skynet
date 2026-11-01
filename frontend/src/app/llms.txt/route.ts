/** /llms.txt: a short map of the docs for language models (https://llmstxt.org). */

import { DOCS_PAGES, DOCS_SECTIONS, docsMarkdownHref } from "@/features/docs";
import { MCP_SERVER_URL } from "@/shared/lib/mcp-clients";
import { getSiteUrl } from "@/shared/lib/site-config";

export async function GET() {
  const site = getSiteUrl();
  const sections = DOCS_SECTIONS.map((section) => {
    const pages = DOCS_PAGES.filter((p) => p.section === section.id).map(
      (p) => `- [${p.title.en}](${site}${docsMarkdownHref(p.slug, "en")}): ${p.description.en}`,
    );
    return `## ${section.title.en}\n\n${pages.join("\n")}`;
  });
  const body = [
    "# Skynet",
    "",
    "> Skynet optimizes prompts, programs, agents and other artifacts against your own data and scorer. Skynet is Optimize Anything: one product for prompts, code, text and DSPy programs, with native engines and DSPy optimizers.",
    "",
    `Every page below is Markdown. The full docs are in one file at ${site}/llms-full.txt. The hosted MCP server is at ${MCP_SERVER_URL}. Hebrew pages are under ${site}/docs/he.`,
    "",
    ...sections.flatMap((s) => [s, ""]),
  ].join("\n");
  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
}
