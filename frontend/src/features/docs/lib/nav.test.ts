import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { FULL_TRANSLATION_LOCALES } from "../../../shared/lib/locale.ts";
import { extractHeadings } from "./markdown.ts";
import {
  DOCS_LOCALES,
  DOCS_PAGES,
  DOCS_SECTIONS,
  docsDir,
  docsHref,
  docsMarkdownHref,
  docsMarkdownSegments,
  docsNeighbors,
  localizeDocsLinks,
  resolveDocsPath,
} from "./nav.ts";

/** The page's Markdown file in a locale, or null when it has no translation yet. */
function contentFile(locale: string, slug: string): URL | null {
  const url = new URL(`../content/${locale}/${slug || "index"}.md`, import.meta.url);
  return existsSync(url) ? url : null;
}

/** The page source a locale serves: its own file, else the English one, with localized links. */
function servedSource(locale: (typeof DOCS_LOCALES)[number], slug: string): string {
  const url = contentFile(locale, slug) ?? contentFile("en", slug);
  assert.ok(url, `missing en/${slug || "index"}.md`);
  return localizeDocsLinks(readFileSync(url, "utf8"), locale);
}

test("the docs locales are the app's full-translation locales", () => {
  assert.deepEqual([...DOCS_LOCALES].sort(), [...FULL_TRANSLATION_LOCALES].sort());
  assert.deepEqual(
    DOCS_LOCALES.filter((l) => docsDir(l) === "rtl"),
    ["he", "ar", "fa"],
  );
});

test("every page has a unique slug, a known section and every locale's title", () => {
  const slugs = DOCS_PAGES.map((p) => p.slug);
  assert.equal(new Set(slugs).size, slugs.length);
  const sections = new Set(DOCS_SECTIONS.map((s) => s.id));
  for (const page of DOCS_PAGES) {
    assert.ok(sections.has(page.section), page.slug);
    for (const locale of DOCS_LOCALES) {
      assert.ok(
        page.title[locale]?.trim() && page.description[locale]?.trim(),
        `${locale}: ${page.slug}`,
      );
    }
    assert.match(page.updated, /^\d{4}-\d{2}-\d{2}$/);
    const first = page.slug.split("/")[0] ?? "";
    assert.ok(
      !(DOCS_LOCALES as readonly string[]).includes(first),
      `${page.slug} collides with a locale prefix`,
    );
  }
  for (const section of DOCS_SECTIONS) {
    for (const locale of DOCS_LOCALES)
      assert.ok(section.title[locale]?.trim(), `${locale}: ${section.id}`);
  }
});

test("pages are listed in section order, so prev/next follows the sidebar", () => {
  const order = DOCS_SECTIONS.map((s) => s.id);
  const indexes = DOCS_PAGES.map((p) => order.indexOf(p.section));
  assert.deepEqual(
    indexes,
    [...indexes].sort((a, b) => a - b),
  );
});

test("resolveDocsPath maps URLs to a locale and page", () => {
  assert.equal(resolveDocsPath([])?.page.slug, "");
  assert.equal(resolveDocsPath([])?.locale, "en");
  assert.deepEqual(
    [
      resolveDocsPath(["he", "concepts", "runs"])?.locale,
      resolveDocsPath(["he", "concepts", "runs"])?.page.slug,
    ],
    ["he", "concepts/runs"],
  );
  assert.equal(resolveDocsPath(["he"])?.page.slug, "");
  assert.deepEqual(
    [resolveDocsPath(["zh-Hans", "mcp"])?.locale, resolveDocsPath(["zh-Hans", "mcp"])?.page.slug],
    ["zh-Hans", "mcp"],
  );
  assert.equal(resolveDocsPath(["en", "mcp"]), null);
  assert.equal(resolveDocsPath(["nope"]), null);
});

test("docsHref and docsMarkdownHref round-trip through resolveDocsPath", () => {
  assert.equal(docsHref("", "en"), "/docs");
  assert.equal(docsHref("mcp", "he"), "/docs/he/mcp");
  assert.equal(docsMarkdownHref("", "en"), "/docs.md");
  assert.equal(docsMarkdownHref("mcp", "en"), "/docs/mcp.md");
  for (const page of DOCS_PAGES) {
    for (const locale of DOCS_LOCALES) {
      const segments = docsHref(page.slug, locale).split("/").slice(2);
      assert.equal(resolveDocsPath(segments)?.page, page);
      assert.equal(resolveDocsPath(segments)?.locale, locale);
    }
  }
});

test("docsNeighbors gives no previous page for the first page", () => {
  assert.equal(docsNeighbors("").prev, null);
  assert.equal(docsNeighbors("")?.next?.slug, DOCS_PAGES[1]?.slug);
  assert.equal(docsNeighbors(DOCS_PAGES.at(-1)!.slug).next, null);
});

test("localizeDocsLinks keeps readers in their locale", () => {
  const md =
    "[a](/docs/api) [b](/docs) [c](/docs/he/faq) [d](/docs#x) [e](/docs-search) [f](https://x.dev/docs/a)";
  assert.equal(localizeDocsLinks(md, "en"), md);
  assert.equal(
    localizeDocsLinks(md, "he"),
    "[a](/docs/he/api) [b](/docs/he) [c](/docs/he/faq) [d](/docs/he#x) [e](/docs-search) [f](https://x.dev/docs/a)",
  );
  assert.equal(
    localizeDocsLinks(md, "zh-Hans"),
    "[a](/docs/zh-Hans/api) [b](/docs/zh-Hans) [c](/docs/he/faq) [d](/docs/zh-Hans#x) [e](/docs-search) [f](https://x.dev/docs/a)",
  );
});

test("every internal docs link in the content points at a real page", () => {
  for (const locale of DOCS_LOCALES) {
    for (const page of DOCS_PAGES) {
      const source = servedSource(locale, page.slug);
      for (const [, href] of source.matchAll(/\]\((\/docs[^)#\s]*)/g)) {
        const segments = href.replace(/\.md$/, "").split("/").filter(Boolean).slice(1);
        assert.ok(resolveDocsPath(segments), `${locale}/${page.slug}: broken link ${href}`);
      }
    }
  }
});

// Heading ids come from the heading text, so each locale has its own anchors.
// A link's #anchor must match a heading of the page that the same locale
// serves (its translation, or the English fallback).
test("every #anchor link in the content points at a real heading", () => {
  for (const locale of DOCS_LOCALES) {
    for (const page of DOCS_PAGES) {
      const source = servedSource(locale, page.slug);
      for (const [, path, anchor] of source.matchAll(/\]\((\/docs[^)#\s]*)?#([^)\s]+)\)/g)) {
        const target = path
          ? resolveDocsPath(path.replace(/\.md$/, "").split("/").filter(Boolean).slice(1))
          : null;
        const slug = target ? target.page.slug : page.slug;
        const ids = extractHeadings(servedSource(locale, slug)).map((h) => h.id);
        assert.ok(
          ids.includes(decodeURIComponent(anchor ?? "")),
          `${locale}/${page.slug}: broken anchor ${path ?? ""}#${anchor}`,
        );
      }
    }
  }
});

const untranslated = DOCS_LOCALES.flatMap((locale) =>
  DOCS_PAGES.filter((page) => !contentFile(locale, page.slug)).map(
    (page) => `${locale}/${page.slug || "index"}.md`,
  ),
);

test(
  "every locale has a Markdown file for every page",
  { todo: untranslated.length > 0 ? `${untranslated.length} pages fall back to English` : false },
  () => {
    assert.equal(untranslated.length, 0, `missing: ${untranslated.slice(0, 5).join(", ")}…`);
  },
);

test("docsMarkdownSegments splits the page path and never throws on a stray percent sign", () => {
  assert.deepEqual(docsMarkdownSegments(["he", "concepts", "runs"]), ["he", "concepts", "runs"]);
  assert.deepEqual(docsMarkdownSegments(["concepts/runs"]), ["concepts", "runs"]);
  // Next decodes /docs-md/%25zz to "%zz"; a second decode throws URIError.
  assert.deepEqual(docsMarkdownSegments(["%zz"]), ["%zz"]);
  assert.equal(resolveDocsPath(docsMarkdownSegments(["%zz"])), null);
});
