/** /llms-full.txt: every English docs page as Markdown, in reading order. */

import { DOCS_PAGES, docsMarkdownDocument } from "@/features/docs";

export async function GET() {
  const body = DOCS_PAGES.map((page) => docsMarkdownDocument(page, "en")).join("\n\n");
  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
}
