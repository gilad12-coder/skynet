// A scorer's note reaches the tree as one text: its prose first, then every
// other side-info entry as a `key: value` line. Renders are meant to be
// stripped before that, but older runs let them through as JSON-quoted data
// URLs, and the note's character cap cuts most of them mid-base64.

export interface ScorerImage {
  key: string;
  src: string;
}

export interface ScorerNote {
  body: string;
  images: ScorerImage[];
  // Render lines the cap cut short: nothing drawable is left of them.
  truncated: number;
}

const IMAGE_LINE = /^([\w.-]+):\s*(")?(data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=]*)(")?\s*$/;

export function parseScorerNote(text: string): ScorerNote {
  const prose: string[] = [];
  const images: ScorerImage[] = [];
  let truncated = 0;
  for (const line of text.split("\n")) {
    const match = IMAGE_LINE.exec(line);
    if (match === null) {
      prose.push(line);
      continue;
    }
    const key = match[1] ?? "";
    const src = match[3] ?? "";
    const opened = match[2] !== undefined;
    const closed = match[4] !== undefined;
    const payload = src.slice(src.indexOf(",") + 1);
    // A quoted line is whole only once its closing quote survived; a bare
    // one can only be judged by its base64 padding.
    const whole = opened ? closed : payload.length % 4 === 0;
    if (whole && payload.length > 0) images.push({ key, src });
    else truncated += 1;
  }
  return { body: prose.join("\n").trim(), images, truncated };
}
