/** The docs search index for one locale, as JSON. The search dialog loads it on first open. */

import { DOCS_SECTIONS, docsSearchIndex, isDocsLocale } from "@/features/docs";

export async function GET(request: Request) {
  const value = new URL(request.url).searchParams.get("locale") ?? "en";
  const locale = isDocsLocale(value) ? value : "en";
  const index = docsSearchIndex(locale, (page) => DOCS_SECTIONS.find((s) => s.id === page.section)?.title[locale] ?? "");
  return Response.json(index, { headers: { "Cache-Control": "public, max-age=300" } });
}
