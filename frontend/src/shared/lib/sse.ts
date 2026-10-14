export interface ServerSentEvent {
  event: string;
  data: Record<string, unknown>;
  /** The SSE `id:` field, when the server numbered the event. */
  id?: string;
}

function normalizeStreamChunk(chunk: string): string {
  return chunk.replace(/\r\n/g, "\n");
}

function parseServerSentEvent(raw: string): ServerSentEvent | null {
  let event = "message";
  let id: string | undefined;
  const dataLines: string[] = [];
  for (const line of normalizeStreamChunk(raw).split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    else if (line.startsWith("id:")) id = line.slice(3).trim();
  }
  if (dataLines.length === 0) return null;
  try {
    const data = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
    return id === undefined ? { event, data } : { event, data, id };
  } catch {
    return null;
  }
}

export async function readServerSentEvents(
  body: ReadableStream<Uint8Array>,
  processEvent: (event: ServerSentEvent) => void,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      buf += decoder.decode();
      if (buf.trim()) {
        const event = parseServerSentEvent(buf);
        if (event) processEvent(event);
      }
      break;
    }
    buf += normalizeStreamChunk(decoder.decode(value, { stream: true }));
    let sepIdx: number;
    while ((sepIdx = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, sepIdx);
      buf = buf.slice(sepIdx + 2);
      const event = parseServerSentEvent(raw);
      if (event) processEvent(event);
    }
  }
}
