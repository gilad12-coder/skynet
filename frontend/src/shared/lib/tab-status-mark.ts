import type { TabActivity } from "./tab-activity";

/**
 * The marks the tab carries: a dot drawn onto the favicon and, for browsers
 * that ignore favicon changes after load (Safari), the same dot as a
 * character in front of the title.
 */
export const TITLE_MARKS: Record<TabActivity, string> = { busy: "●", idle: "○" };

const DOT_FILLS: Record<TabActivity, string> = { busy: "#1a7a3a", idle: "#9a948d" };

// Bottom-right of the 96-unit tile, with a ring in the tile's own cream so the
// dot stays separated from the wordmark at 16px.
const DOT = 'cx="74" cy="74" r="17" stroke="#faf8f5" stroke-width="5"';

const TITLE_MARK_PREFIX = new RegExp(`^(?:${Object.values(TITLE_MARKS).join("|")}) `);

export function stripTitleMark(title: string): string {
  return title.replace(TITLE_MARK_PREFIX, "");
}

export function markTitle(title: string, activity: TabActivity | null): string {
  const bare = stripTitleMark(title);
  return activity === null ? bare : `${TITLE_MARKS[activity]} ${bare}`;
}

/** The favicon's SVG with the status dot drawn over its corner, as a data URL. */
export function markFavicon(svg: string, activity: TabActivity): string {
  const close = svg.lastIndexOf("</svg>");
  if (close === -1) throw new Error("The favicon is not an SVG document");
  const circle = `<circle ${DOT} fill="${DOT_FILLS[activity]}"/>`;
  const marked = `${svg.slice(0, close)}${circle}${svg.slice(close)}`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(marked)}`;
}
