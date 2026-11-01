/** Public documentation at /docs (English) and /docs/he (Hebrew). No sign-in. */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DOCS_CHROME, DocsMarkdown, DocsShell, docsHref, docsMarkdownDocument, docsSource, extractHeadings, resolveDocsPath } from "@/features/docs";
import { APP_NAME } from "@/shared/lib/brand";
import { getSiteUrl } from "@/shared/lib/site-config";

type Props = { params: Promise<{ slug?: string[] }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const resolved = resolveDocsPath((await params).slug ?? []);
  if (!resolved) return {};
  const { locale, page } = resolved;
  const title = `${page.title[locale]} · ${DOCS_CHROME[locale].docs}`;
  const url = docsHref(page.slug, locale);
  return {
    title,
    description: page.description[locale],
    alternates: {
      canonical: url,
      languages: {
        en: docsHref(page.slug, "en"),
        he: docsHref(page.slug, "he"),
        "x-default": docsHref(page.slug, "en"),
      },
      types: { "text/markdown": `${url}.md` },
    },
    openGraph: {
      type: "article",
      siteName: APP_NAME,
      title,
      description: page.description[locale],
      url,
      locale: locale === "he" ? "he_IL" : "en_US",
      modifiedTime: page.updated,
    },
    robots: { index: true, follow: true },
  };
}

export default async function DocsPage({ params }: Props) {
  const resolved = resolveDocsPath((await params).slug ?? []);
  if (!resolved) notFound();
  const { locale, page } = resolved;
  const chrome = DOCS_CHROME[locale];
  const source = docsSource(page, locale);
  const headings = extractHeadings(source);
  const siteUrl = getSiteUrl();

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: page.title[locale],
    description: page.description[locale],
    inLanguage: locale,
    url: `${siteUrl}${docsHref(page.slug, locale)}`,
    dateModified: page.updated,
    isPartOf: { "@type": "WebSite", name: `${APP_NAME} ${chrome.docs}`, url: `${siteUrl}${docsHref("", locale)}` },
    publisher: { "@type": "Organization", name: APP_NAME, url: siteUrl },
  };

  return (
    <DocsShell locale={locale} page={page} headings={headings} markdown={docsMarkdownDocument(page, locale)}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }}
      />
      <DocsMarkdown source={source} headingIds={headings.map((h) => h.id)} locale={locale} chrome={chrome} />
    </DocsShell>
  );
}
