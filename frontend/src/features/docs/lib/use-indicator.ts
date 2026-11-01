"use client";

import * as React from "react";

export interface IndicatorBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Measure the child marked `data-active="true"` inside a `relative`
 * container, so one shared indicator can slide to it. `moved` stays false
 * until the second measure, so the indicator appears in place on load and
 * only slides on later changes.
 */
export function useIndicator<T extends HTMLElement>(activeKey: unknown) {
  const ref = React.useRef<T | null>(null);
  const [box, setBox] = React.useState<IndicatorBox | null>(null);
  const [moved, setMoved] = React.useState(false);
  const measured = React.useRef(false);

  React.useLayoutEffect(() => {
    const container = ref.current;
    if (!container) return;
    const measure = () => {
      const el = container.querySelector<HTMLElement>('[data-active="true"]');
      setBox(
        el
          ? { x: el.offsetLeft, y: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight }
          : null,
      );
    };
    measure();
    if (measured.current) setMoved(true);
    measured.current = true;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [activeKey]);

  return { ref, box, moved };
}
