// Markers that only show up when text was written as markdown: a heading, a
// list item, bold, inline code, a link or a table row. Plain sentences, JSON
// and logs match none of them, so they stay as raw text.
const MARKDOWN_HINT =
  /^#{1,6}\s|^\s*[-*+]\s|^\s*\d+\.\s|\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|^\|.+\|$/m;

/** Whether `text` reads as markdown worth rendering rather than plain text. */
export function looksLikeMarkdown(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || /^[[{]/.test(trimmed)) return false;
  return MARKDOWN_HINT.test(trimmed);
}
