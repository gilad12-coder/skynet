/**
 * Keeps the page around the IDE from scrolling itself.
 *
 * An `overflow: hidden` box clips but is still a scroll container: when
 * VS Code focuses the editor's input node (no `preventScroll`), or the caret
 * moves as one types, the browser scrolls every such ancestor to reveal it.
 * Monaco undoes this inside the editor and VS Code resets only its own
 * container's `scrollTop`, so a wizard frame above the IDE kept the offset:
 * the header slid out of view and an empty band opened above the nav.
 *
 * The same happens to clipping boxes inside the workbench: a paste or a click
 * into metric.py could scroll one of the editor's own frames sideways, so the
 * code slid out of view while the cursor still read Ln 1, Col 1.
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

/**
 * Pin, at scroll offset 0, every clipping box inside `root` that the browser
 * scrolls to reveal the focused node.
 *
 * Returns:
 *   A function that removes the listener.
 */
export function guardClippingInside(root: HTMLElement): () => void {
  // `scroll` does not bubble, but a capturing listener still sees it.
  const reset = (event: Event) => {
    const box = event.target;
    if (!(box instanceof HTMLElement) || box === root) return;
    const focused = box.ownerDocument.activeElement;
    // Only a box that holds the focus was moved by the browser to reveal it;
    // VS Code's own scrollers are `auto` or move their content by script.
    if (!focused || !box.contains(focused) || !clipsButScrolls(getComputedStyle(box))) return;
    if (box.scrollTop !== 0) box.scrollTop = 0;
    if (box.scrollLeft !== 0) box.scrollLeft = 0;
  };
  root.addEventListener("scroll", reset, { capture: true, passive: true });
  return () => root.removeEventListener("scroll", reset, { capture: true });
}
