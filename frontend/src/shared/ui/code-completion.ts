import type { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

const PROSE_NODES = new Set(["Comment", "String", "FormatString"]);

/**
 * Whether the cursor sits in a comment or string, where the user writes prose
 * and a completion accepted with Enter would replace the word they typed.
 */
export function inCommentOrString(state: EditorState, pos: number): boolean {
  let node = syntaxTree(state).resolveInner(pos, -1);
  for (;;) {
    if (PROSE_NODES.has(node.name)) return true;
    if (!node.parent) return false;
    node = node.parent;
  }
}
