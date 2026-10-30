/**
 * Pure rules for collapsing a long chat message to a preview, kept apart from
 * the component so the tests pin them without a DOM.
 */

/** Rendered lines a collapsed message keeps visible (Codex shows 18). */
export const COLLAPSED_LINES = 18;

/** Height animation length for Show more / Show less, in milliseconds. */
export const COLLAPSE_ANIMATION_MS = 220;

// Sub-pixel rounding can leave scrollHeight a fraction above an exact fit, which
// would put a toggle under a message that has nothing hidden.
const OVERFLOW_TOLERANCE_PX = 1;

/**
 * The collapsed height of a message, in pixels.
 *
 * Args:
 *   lineHeightPx: The message's computed line height.
 *
 * Returns:
 *   The clamp height, or null when the line height is unknown.
 */
export function clampHeight(lineHeightPx: number): number | null {
  if (!Number.isFinite(lineHeightPx) || lineHeightPx <= 0) return null;
  return lineHeightPx * COLLAPSED_LINES;
}

/**
 * Whether a message is long enough to collapse.
 *
 * Measured from the rendered height, not a character count, so the threshold
 * holds at every bubble width.
 *
 * Args:
 *   scrollHeight: The full rendered height of the message body.
 *   clampPx: The collapsed height from {@link clampHeight}.
 *
 * Returns:
 *   True when the body is taller than the clamp.
 */
export function shouldCollapse(scrollHeight: number, clampPx: number | null): boolean {
  if (clampPx === null) return false;
  return scrollHeight > clampPx + OVERFLOW_TOLERANCE_PX;
}

/**
 * The CSS max-height of the message body.
 *
 * Expanded uses the measured full height rather than "none" so the height
 * transition has two lengths to animate between.
 *
 * Args:
 *   expanded: Whether the user expanded the message.
 *   scrollHeight: The full rendered height of the message body.
 *   clampPx: The collapsed height from {@link clampHeight}.
 *
 * Returns:
 *   A CSS length.
 */
export function bodyMaxHeight(
  expanded: boolean,
  scrollHeight: number,
  clampPx: number | null,
): string {
  if (expanded) return `${Math.ceil(scrollHeight)}px`;
  if (clampPx === null) return `${COLLAPSED_LINES}lh`;
  return `${clampPx}px`;
}

/**
 * The i18n key for the toggle's label.
 *
 * Args:
 *   expanded: Whether the message is expanded.
 *
 * Returns:
 *   "Show less" when expanded, else "Show more".
 */
export function toggleLabelKey(
  expanded: boolean,
): "shared.agent.show_less" | "shared.agent.show_more" {
  return expanded ? "shared.agent.show_less" : "shared.agent.show_more";
}

/**
 * Whether collapsing should scroll the message back into view.
 *
 * After reading an expanded message the user is at its bottom; collapsing
 * shrinks it upward and would leave them looking past it.
 *
 * Args:
 *   messageTop: The message's top edge, in viewport pixels.
 *   viewportTop: The top edge of the visible area that scrolls it.
 *
 * Returns:
 *   True when the message top sits above the visible area.
 */
export function needsScrollBack(messageTop: number, viewportTop: number): boolean {
  return messageTop < viewportTop;
}
