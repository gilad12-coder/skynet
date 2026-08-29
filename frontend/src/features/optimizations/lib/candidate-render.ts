/** How a candidate's text is best drawn: the preview renderer picks by kind. */
export type RenderKind = "markdown" | "svg" | "html" | "json" | "python" | "code";

export const RENDER_KIND_EXTENSION: Record<RenderKind, string> = {
  markdown: "md",
  svg: "svg",
  html: "html",
  json: "json",
  python: "py",
  code: "txt",
};

const SVG_START = /^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i;
const HTML_DOCUMENT_START = /^(?:<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>])/i;
const HTML_FRAGMENT_START =
  /^<(?:div|section|main|article|style|script|table|form|nav|header|footer)[\s>]/i;
const CLOSING_TAG_END = /<\/\w+>\s*$/;
const MARKDOWN_FENCE = /^```/m;
const PYTHON_START =
  /^(?:def\s+\w+\s*\(|class\s+\w+\s*[(:]|import\s+\w+|from\s+[\w.]+\s+import\s|if\s+__name__\s*==)/m;
const CODE_START =
  /^(?:#include\b|package\s+\w|fn\s+\w+\s*\(|func\s+\w+\s*\(|(?:export\s+)?(?:function|const|let|var|interface)\s+\w+|<\?php|#!\/|__global__|__kernel\b)/m;

/**
 * Guess the renderer for a candidate from its text alone. Prompts and
 * documents fall through to markdown, which also draws plain text faithfully.
 */
export function detectRenderKind(text: string): RenderKind {
  const t = text.trim();
  if (!t) return "markdown";
  if (SVG_START.test(t)) return "svg";
  if (HTML_DOCUMENT_START.test(t) || (HTML_FRAGMENT_START.test(t) && CLOSING_TAG_END.test(t)))
    return "html";
  if (/^[[{]/.test(t)) {
    try {
      JSON.parse(t);
      return "json";
    } catch {
      /* not JSON: keep detecting */
    }
  }
  // A fenced block means prose with embedded code, not a program.
  if (MARKDOWN_FENCE.test(t)) return "markdown";
  if (PYTHON_START.test(t)) return "python";
  if (CODE_START.test(t)) return "code";
  return "markdown";
}

export interface SideImage {
  key: string;
  src: string;
}

function isDataImage(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("data:image/");
}

/** Inline images the scorer attached — top-level values or lists of them — in key order. */
export function sideInfoImages(sideInfo: Record<string, unknown> | null | undefined): SideImage[] {
  const images: SideImage[] = [];
  for (const [key, value] of Object.entries(sideInfo ?? {})) {
    if (isDataImage(value)) images.push({ key, src: value });
    else if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (isDataImage(item)) images.push({ key: `${key}[${i}]`, src: item });
      });
    }
  }
  return images;
}

/** Everything else the scorer said, flattened to display strings. */
export function sideInfoNotes(
  sideInfo: Record<string, unknown> | null | undefined,
): Array<[string, string]> {
  const notes: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(sideInfo ?? {})) {
    if (isDataImage(value)) continue;
    if (Array.isArray(value)) {
      const rest = value.filter((item) => !isDataImage(item));
      if (rest.length === 0) continue;
      notes.push([
        key,
        rest.every((item) => typeof item === "string")
          ? rest.join("\n")
          : JSON.stringify(rest, null, 2),
      ]);
      continue;
    }
    if (value == null) continue;
    notes.push([key, typeof value === "string" ? value : JSON.stringify(value, null, 2)]);
  }
  return notes;
}

/** Wrap an SVG so it centres and scales inside the sandboxed frame. */
export function svgDocument(svg: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#fff}body{display:grid;place-items:center}svg{max-width:100%;max-height:100vh}</style></head><body>${svg}</body></html>`;
}

export function formatJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
