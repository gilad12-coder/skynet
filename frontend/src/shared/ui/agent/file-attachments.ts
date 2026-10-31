/**
 * Read files picked or pasted into an agent composer. Any file type is
 * accepted: the backend turns each one into the text the agent reads (or a
 * short note when it cannot), so the composer never filters by extension.
 */

import type { AttachedFile } from "./pasted-text.ts";

/** Matches the backend's MAX_ATTACHMENT_BYTES; larger files are not uploaded. */
export const MAX_ATTACHMENT_MB = 20;
const MAX_ATTACHMENT_BYTES = MAX_ATTACHMENT_MB * 1024 * 1024;

export interface ReadAttachments {
  attached: AttachedFile[];
  failed: string[];
  tooLarge: string[];
}

/** Read each file's text for the agent, keeping the order they were picked in. */
export async function readAttachments(
  files: readonly File[],
  extract: (file: File) => Promise<string>,
): Promise<ReadAttachments> {
  const result: ReadAttachments = { attached: [], failed: [], tooLarge: [] };
  const read = await Promise.all(
    files.map(async (file) => {
      if (file.size > MAX_ATTACHMENT_BYTES) return { file, status: "tooLarge" as const };
      try {
        return { file, status: "ok" as const, text: await extract(file) };
      } catch {
        return { file, status: "failed" as const };
      }
    }),
  );
  for (const entry of read) {
    if (entry.status === "ok") result.attached.push({ name: entry.file.name, text: entry.text });
    else if (entry.status === "tooLarge") result.tooLarge.push(entry.file.name);
    else result.failed.push(entry.file.name);
  }
  return result;
}
