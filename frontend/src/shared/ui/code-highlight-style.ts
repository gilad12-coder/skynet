import { tags, type Tag } from "@lezer/highlight";

export interface CodeHighlightSpec {
  tag: Tag;
  color: string;
  fontWeight?: "bold";
  fontStyle?: "italic";
}

/**
 * The beige syntax palette, shared by the code editor and the read-only
 * file views that highlight without an editor.
 */
export const CODE_HIGHLIGHT_SPECS: CodeHighlightSpec[] = [
  { tag: tags.keyword, color: "#8B5E3C", fontWeight: "bold" },
  { tag: tags.operator, color: "#7C6350" },
  { tag: tags.special(tags.variableName), color: "#6B4226" },
  { tag: tags.typeName, color: "#8B6914" },
  { tag: tags.atom, color: "#8B6914" },
  { tag: tags.number, color: "#986832" },
  { tag: tags.definition(tags.variableName), color: "#3D2E22" },
  { tag: tags.string, color: "#5A7247" },
  { tag: tags.special(tags.string), color: "#5A7247" },
  { tag: tags.comment, color: "#8A7558", fontStyle: "italic" },
  { tag: tags.variableName, color: "#3D2E22" },
  { tag: tags.bracket, color: "#8C7A6B" },
  { tag: tags.tagName, color: "#8B5E3C" },
  { tag: tags.attributeName, color: "#8B6914" },
  { tag: tags.propertyName, color: "#6B4226" },
  { tag: tags.className, color: "#6B4226" },
  { tag: tags.function(tags.variableName), color: "#7C5030" },
  { tag: tags.bool, color: "#8B6914" },
  { tag: tags.null, color: "#8B6914" },
  { tag: tags.self, color: "#8B5E3C", fontStyle: "italic" },
  { tag: tags.punctuation, color: "#8C7A6B" },
];
