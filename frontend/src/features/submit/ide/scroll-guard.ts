/**
 * Keeps the page around the IDE from scrolling itself.
 *
 * An `overflow: hidden` box clips but is still a scroll container: when
 * VS Code focuses the editor's input node (no `preventScroll`), or the caret
 * moves as one types, the browser scrolls every such ancestor to reveal it.
 * Monaco undoes this inside the editor and VS Code resets only its own
 * container's `scrollTop`, so a wizard frame above the IDE kept the offset:
 * the header slid out of view and an empty band opened above the nav.
 */

/** The slice of a computed style this reads. */
export interface OverflowStyle {
  overflowX: string;
  overflowY: string;
}

/** True for a box that hides its overflow yet can still be scrolled by script or focus. */
export function clipsButScrolls(style: OverflowStyle): boolean {
  return style.overflowX === "hidden" || style.overflowY === "hidden";
}

/**
 * Pin every clipping ancestor of `start` (itself included, `body` excluded) at
 * scroll offset 0 while it holds the IDE.
 *
 * Returns:
 *   A function that removes the listeners.
 */
export function guardClippingAncestors(start: HTMLElement): () => void {
  const undo: Array<() => void> = [];
  const stop = start.ownerDocument.body;
  for (let el: HTMLElement | null = start; el && el !== stop; el = el.parentElement) {
    if (!clipsButScrolls(getComputedStyle(el))) continue;
    const box = el;
    const reset = () => {
      if (box.scrollTop !== 0) box.scrollTop = 0;
      if (box.scrollLeft !== 0) box.scrollLeft = 0;
    };
    reset();
    box.addEventListener("scroll", reset, { passive: true });
    undo.push(() => box.removeEventListener("scroll", reset));
  }
  return () => {
    for (const fn of undo) fn();
  };
}
