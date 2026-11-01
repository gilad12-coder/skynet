/** Public surface of the docs feature: the page frame, the renderer and the content. */

export { DocsMarkdown } from "./components/docs-markdown";
export { DocsShell } from "./components/docs-shell";
export { DOCS_CHROME } from "./lib/chrome";
export { docsMarkdownDocument, docsSearchIndex, docsSource } from "./lib/content";
export { extractHeadings } from "./lib/markdown";
export {
  DOCS_PAGES,
  DOCS_SECTIONS,
  docsHref,
  docsMarkdownHref,
  docsMarkdownSegments,
  isDocsLocale,
  resolveDocsPath,
  type DocsLocale,
} from "./lib/nav";
