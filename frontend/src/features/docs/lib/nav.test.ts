import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  DOCS_PAGES,
  DOCS_SECTIONS,
  docsHref,
  docsMarkdownHref,
  docsMarkdownSegments,
  docsNeighbors,
  localizeDocsLinks,
  resolveDocsPath,
} from "./nav.ts";

test("every page has a unique slug, a known section and both languages", () => {
  const slugs = DOCS_PAGES.map((p) => p.slug);
  assert.equal(new Set(slugs).size, slugs.length);
  const sections = new Set(DOCS_SECTIONS.map((s) => s.id));
  for (const page of DOCS_PAGES) {
    assert.ok(sections.has(page.section), page.slug);
    assert.ok(page.title.en && page.title.he && page.description.en && page.description.he, page.slug);
    assert.match(page.updated, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(!page.slug.startsWith("he"), "a slug must not collide with the Hebrew prefix");
  }
});

test("pages are listed in section order, so prev/next follows the sidebar", () => {
  const order = DOCS_SECTIONS.map((s) => s.id);
  const indexes = DOCS_PAGES.map((p) => order.indexOf(p.section));
  assert.deepEqual(indexes, [...indexes].sort((a, b) => a - b));
});

test("resolveDocsPath maps URLs to a locale and page", () => {
  assert.equal(resolveDocsPath([])?.page.slug, "");
  assert.equal(resolveDocsPath([])?.locale, "en");
  assert.deepEqual(
    [resolveDocsPath(["he", "concepts", "runs"])?.locale, resolveDocsPath(["he", "concepts", "runs"])?.page.slug],
    ["he", "concepts/runs"],
  );
  assert.equal(resolveDocsPath(["he"])?.page.slug, "");
  assert.equal(resolveDocsPath(["nope"]), null);
});

test("docsHref and docsMarkdownHref round-trip through resolveDocsPath", () => {
  assert.equal(docsHref("", "en"), "/docs");
  assert.equal(docsHref("mcp", "he"), "/docs/he/mcp");
  assert.equal(docsMarkdownHref("", "en"), "/docs.md");
  assert.equal(docsMarkdownHref("mcp", "en"), "/docs/mcp.md");
  for (const page of DOCS_PAGES) {
    for (const locale of ["en", "he"] as const) {
      const segments = docsHref(page.slug, locale).split("/").slice(2);
      assert.equal(resolveDocsPath(segments)?.page, page);
    }
  }
});

test("docsNeighbors gives no previous page for the first page", () => {
  assert.equal(docsNeighbors("").prev, null);
  assert.equal(docsNeighbors("")?.next?.slug, DOCS_PAGES[1]?.slug);
  assert.equal(docsNeighbors(DOCS_PAGES.at(-1)!.slug).next, null);
});

test("localizeDocsLinks keeps Hebrew readers on Hebrew pages", () => {
  const md = "[a](/docs/api) [b](/docs) [c](/docs/he/faq) [d](/docs#x) [e](/docs-search) [f](https://x.dev/docs/a)";
  assert.equal(localizeDocsLinks(md, "en"), md);
  assert.equal(
    localizeDocsLinks(md, "he"),
    "[a](/docs/he/api) [b](/docs/he) [c](/docs/he/faq) [d](/docs/he#x) [e](/docs-search) [f](https://x.dev/docs/a)",
  );
});

test("every internal docs link in the content points at a real page", () => {
  for (const locale of ["en", "he"] as const) {
    for (const page of DOCS_PAGES) {
      const url = new URL(`../content/${locale}/${page.slug || "index"}.md`, import.meta.url);
      const source = localizeDocsLinks(readFileSync(url, "utf8"), locale);
      for (const [, href] of source.matchAll(/\]\((\/docs[^)#\s]*)/g)) {
        const segments = href.replace(/\.md$/, "").split("/").filter(Boolean).slice(1);
        assert.ok(resolveDocsPath(segments), `${locale}/${page.slug}: broken link ${href}`);
      }
    }
  }
});

test("docsMarkdownSegments splits the page path and never throws on a stray percent sign", () => {
  assert.deepEqual(docsMarkdownSegments(["he", "concepts", "runs"]), ["he", "concepts", "runs"]);
  assert.deepEqual(docsMarkdownSegments(["concepts/runs"]), ["concepts", "runs"]);
  // Next decodes /docs-md/%25zz to "%zz"; a second decode throws URIError.
  assert.deepEqual(docsMarkdownSegments(["%zz"]), ["%zz"]);
  assert.equal(resolveDocsPath(docsMarkdownSegments(["%zz"])), null);
});
