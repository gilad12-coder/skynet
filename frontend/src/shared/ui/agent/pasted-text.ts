/**
 * Long pastes ride inside the message string as tagged blocks, so every chat
 * keeps its plain `value: string` contract and the agent still reads the full
 * text, while the composer and the sent bubble show each block as a card.
 */

/** Same cutoff ChatGPT uses before a paste becomes an attachment. */
export const PASTE_ATTACHMENT_MIN_CHARS = 5000;

const BLOCK_RE = /<pasted_text>\n?([\s\S]*?)\n?<\/pasted_text>\n*/g;

export interface SplitMessage {
  text: string;
  pastes: string[];
}

/** Separate a message into what was typed and its pasted-text blocks. */
export function splitPastes(value: string): SplitMessage {
  const pastes: string[] = [];
  const text = value.replace(BLOCK_RE, (_, body: string) => {
    pastes.push(body);
    return "";
  });
  return { text: pastes.length ? text.replace(/^\s+/, "") : text, pastes };
}

/** Rebuild the message string, pastes first so the agent reads them as context. */
export function joinPastes({ text, pastes }: SplitMessage): string {
  if (!pastes.length) return text;
  const blocks = pastes.map((p) => `<pasted_text>\n${p}\n</pasted_text>`).join("\n\n");
  return text ? `${blocks}\n\n${text}` : blocks;
}

/** Whether a paste is long enough to become a card instead of draft text. */
export function shouldAttachPaste(pasted: string): boolean {
  return pasted.length >= PASTE_ATTACHMENT_MIN_CHARS;
}

export function countLines(text: string): number {
  return text ? text.split("\n").length : 0;
}
