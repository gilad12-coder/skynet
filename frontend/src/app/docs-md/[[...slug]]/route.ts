/**
 * The Markdown twin of every docs page. next.config.ts rewrites
 * /docs.md and /docs/<page>.md here.
 */

import { docsMarkdownDocument, docsMarkdownSegments, resolveDocsPath } from "@/features/docs";

export async function GET(_request: Request, { params }: { params: Promise<{ slug?: string[] }> }) {
  const segments = docsMarkdownSegments((await params).slug ?? []);
  const resolved = resolveDocsPath(segments);
  if (!resolved) return new Response("Not found\n", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  return new Response(docsMarkdownDocument(resolved.page, resolved.locale), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "X-Robots-Tag": "noindex",
    },
  });
}
