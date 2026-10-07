import { useCallback, useRef, type PointerEvent, type RefObject } from "react";

type Point = { x: number; y: number };

function spread(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Two-finger pinch zoom for the pan-and-zoom canvases. The canvases set
 * `touch-action: none` so a one-finger drag pans the drawing instead of the
 * page, which also turns off the browser's own pinch, so on a touch screen
 * the pinch has to be rebuilt from pointer events.
 *
 * `start` returns true once a second finger lands, and the caller drops its
 * one-finger pan; `move` returns true while it is zooming.
 */
export function usePinchZoom(
  containerRef: RefObject<HTMLElement | null>,
  zoomAt: (cx: number, cy: number, factor: number) => void,
) {
  const pointersRef = useRef(new Map<number, Point>());
  const lastSpreadRef = useRef<number | null>(null);

  const start = useCallback((e: PointerEvent): boolean => {
    if (e.pointerType !== "touch") return false;
    const pointers = pointersRef.current;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size !== 2) return false;
    const [a, b] = [...pointers.values()];
    lastSpreadRef.current = a !== undefined && b !== undefined ? spread(a, b) : null;
    return true;
  }, []);

  const move = useCallback(
    (e: PointerEvent): boolean => {
      const pointers = pointersRef.current;
      if (!pointers.has(e.pointerId)) return false;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const last = lastSpreadRef.current;
      if (last === null || pointers.size !== 2) return false;
      const [a, b] = [...pointers.values()];
      const rect = containerRef.current?.getBoundingClientRect();
      if (a === undefined || b === undefined || rect === undefined) return true;
      const next = spread(a, b);
      if (last > 0 && next > 0) {
        zoomAt((a.x + b.x) / 2 - rect.left, (a.y + b.y) / 2 - rect.top, next / last);
      }
      lastSpreadRef.current = next;
      return true;
    },
    [containerRef, zoomAt],
  );

  const end = useCallback((e: PointerEvent) => {
    const pointers = pointersRef.current;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) lastSpreadRef.current = null;
  }, []);

  return { start, move, end };
}
