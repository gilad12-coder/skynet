/**
 * Full screen grows the IDE out of its inline slot, and shrinks it back.
 *
 * The pop-up layer is laid out at full size from the first frame, so the
 * workbench never re-lays out mid-animation; only its clip moves, from the
 * slot's rectangle to the whole viewport.
 */

export const ZOOM_MS = 220;
export const ZOOM_EASING = "cubic-bezier(0.2, 0, 0, 1)";

/** The slice of a DOMRect the clip needs. */
export interface SlotRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const px = (n: number) => `${Math.max(0, Math.round(n))}px`;

/**
 * The clip-path keyframes from the inline slot to the full viewport.
 *
 * Args:
 *   slot: The inline slot's viewport rectangle.
 *   width / height: The viewport's size.
 *   radius: The slot's corner radius.
 *
 * Returns:
 *   Two keyframes, slot first; reverse them to shrink back.
 */
export function zoomFrames(
  slot: SlotRect,
  width: number,
  height: number,
  radius = 12,
): Keyframe[] {
  const from = `inset(${px(slot.top)} ${px(width - slot.right)} ${px(height - slot.bottom)} ${px(slot.left)} round ${px(radius)})`;
  return [{ clipPath: from }, { clipPath: "inset(0px 0px 0px 0px round 0px)" }];
}

/** The user asked for less motion; full screen then switches at once. */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}
