import { tags, type Tag } from "@lezer/highlight";

export interface CodeHighlightSpec {
  tag: Tag;
  color: string;
  fontWeight?: "bold";
  fontStyle?: "italic";
}

/**
 * The syntax palette, shared by the code editor and the read-only file
 * views that highlight without an editor. Colours resolve from the
 * `--code-*` tokens in globals.css so they follow the colour theme.
 */
export const CODE_HIGHLIGHT_SPECS: CodeHighlightSpec[] = [
  { tag: tags.keyword, color: "var(--code-keyword)", fontWeight: "bold" },
  { tag: tags.operator, color: "var(--code-operator)" },
  { tag: tags.special(tags.variableName), color: "var(--code-accent)" },
  { tag: tags.typeName, color: "var(--code-type)" },
  { tag: tags.atom, color: "var(--code-type)" },
  { tag: tags.number, color: "var(--code-number)" },
  { tag: tags.definition(tags.variableName), color: "var(--code-text)" },
  { tag: tags.string, color: "var(--code-string)" },
  { tag: tags.special(tags.string), color: "var(--code-string)" },
  { tag: tags.comment, color: "var(--code-comment)", fontStyle: "italic" },
  { tag: tags.variableName, color: "var(--code-text)" },
  { tag: tags.bracket, color: "var(--code-punct)" },
  { tag: tags.tagName, color: "var(--code-keyword)" },
  { tag: tags.attributeName, color: "var(--code-type)" },
  { tag: tags.propertyName, color: "var(--code-accent)" },
  { tag: tags.className, color: "var(--code-accent)" },
  { tag: tags.function(tags.variableName), color: "var(--code-function)" },
  { tag: tags.bool, color: "var(--code-type)" },
  { tag: tags.null, color: "var(--code-type)" },
  { tag: tags.self, color: "var(--code-keyword)", fontStyle: "italic" },
  { tag: tags.punctuation, color: "var(--code-punct)" },
];
