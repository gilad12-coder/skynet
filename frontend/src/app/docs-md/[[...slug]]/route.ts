/**
 * The Markdown twin of every docs page. next.config.ts rewrites
 * /docs.md and /docs/<page>.md here.
 */

import { docsMarkdownDocument, resolveDocsPath } from "@/features/docs";

export async function GET(_request: Request, { params }: { params: Promise<{ slug?: string[] }> }) {
  // The rewrite can pass the page path as one encoded segment ("concepts%2Fruns").
  const segments = ((await params).slug ?? []).flatMap((part) => decodeURIComponent(part).split("/")).filter(Boolean);
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
