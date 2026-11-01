/**
 * Server-side syntax colours for docs code blocks. It uses the code editor's
 * own grammars and palette, so the browser downloads no highlighter.
 */

import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightCode, tagHighlighter } from "@lezer/highlight";
import { CODE_HIGHLIGHT_SPECS, type CodeHighlightSpec } from "@/shared/ui/code-highlight-style";

export interface CodeToken {
  text: string;
  spec: CodeHighlightSpec | null;
}

const highlighter = tagHighlighter(
  CODE_HIGHLIGHT_SPECS.map((spec, i) => ({ tag: spec.tag, class: String(i) })),
);

/**
 * Tokens per line for a code block, or null when no grammar matches the
 * language name. The caller then shows plain text.
 */
export async function highlightDocsCode(language: string, code: string): Promise<CodeToken[][] | null> {
  if (!language || language === "text") return null;
  const description = LanguageDescription.matchLanguageName(languages, language, true);
  if (!description) return null;
  const support = await description.load();
  const tree = support.language.parser.parse(code);
  const lines: CodeToken[][] = [[]];
  highlightCode(
    code,
    tree,
    highlighter,
    (text, classes) => {
      // Nested tags come back space-separated; the innermost wins.
      const last = classes.split(" ").filter(Boolean).pop();
      const spec = last == null ? null : (CODE_HIGHLIGHT_SPECS[Number(last)] ?? null);
      lines[lines.length - 1]?.push({ text, spec });
    },
    () => lines.push([]),
  );
  return lines;
}
