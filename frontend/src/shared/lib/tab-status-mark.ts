import type { TabActivity } from "./tab-activity";

// The status dot sits on the logo itself, the way Claude marks its sessions:
// gray while a surface waits, green while it works.
const DOT_FILLS: Record<TabActivity, string> = { busy: "#1a7a3a", idle: "#9a948d" };

// Over the wordmark's bottom-right corner of the 96-unit tile, with a ring in
// the tile's own cream so the dot stays separated from the letters at 16px.
const DOT = 'cx="78" cy="78" r="13" stroke="#faf8f5" stroke-width="4"';

/** The favicon's SVG with the status dot drawn over the logo, as a data URL. */
export function markFavicon(svg: string, activity: TabActivity): string {
  const close = svg.lastIndexOf("</svg>");
  if (close === -1) throw new Error("The favicon is not an SVG document");
  const circle = `<circle ${DOT} fill="${DOT_FILLS[activity]}"/>`;
  const marked = `${svg.slice(0, close)}${circle}${svg.slice(close)}`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(marked)}`;
}
