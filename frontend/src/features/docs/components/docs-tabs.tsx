"use client";

import * as React from "react";
import { cn } from "@/shared/lib/utils";
import { useIndicator } from "../lib/use-indicator";

/**
 * Tabs for docs content: code in several languages, or setup steps for
 * several clients. Every panel is in the server HTML, so search engines and
 * readers without JavaScript still get all of them.
 */
export function DocsTabs({
  labels,
  panels,
  ariaLabel,
}: {
  labels: string[];
  panels: React.ReactNode[];
  ariaLabel?: string;
}) {
  const [active, setActive] = React.useState(0);
  const [switched, setSwitched] = React.useState(false);
  const { ref: indicatorRef, box, moved } = useIndicator<HTMLDivElement>(active);
  const id = React.useId();
  const tabs = React.useRef<Array<HTMLButtonElement | null>>([]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    const forward = rtl ? "ArrowLeft" : "ArrowRight";
    const back = rtl ? "ArrowRight" : "ArrowLeft";
    let next = active;
    if (event.key === forward) next = (active + 1) % labels.length;
    else if (event.key === back) next = (active - 1 + labels.length) % labels.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = labels.length - 1;
    else return;
    event.preventDefault();
    setSwitched(true);
    setActive(next);
    tabs.current[next]?.focus();
  };

  return (
    <div className="docs-tabs my-5">
      <div
        ref={indicatorRef}
        role="tablist"
        aria-label={ariaLabel}
        onKeyDown={onKeyDown}
        className="relative flex gap-1 overflow-x-auto border-b border-border [scrollbar-width:none]"
      >
        {labels.map((label, i) => (
          <button
            key={label}
            ref={(el) => {
              tabs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${id}-tab-${i}`}
            aria-selected={i === active}
            aria-controls={`${id}-panel-${i}`}
            tabIndex={i === active ? 0 : -1}
            data-active={i === active}
            onClick={() => {
              setSwitched(true);
              setActive(i);
            }}
            className={cn(
              "-mb-px shrink-0 cursor-pointer border-b-2 border-transparent px-3 py-2 text-sm font-medium transition-colors duration-200",
              i === active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
        {box && (
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute bottom-0 left-0 h-0.5 rounded-full bg-primary",
              moved && "docs-indicator",
            )}
            style={{
              width: box.width,
              transform: `translateX(${box.x}px)`,
            }}
          />
        )}
      </div>
      {panels.map((panel, i) => (
        <div
          key={labels[i]}
          role="tabpanel"
          id={`${id}-panel-${i}`}
          aria-labelledby={`${id}-tab-${i}`}
          hidden={i !== active}
          // Fade only after a switch, so the first paint does not animate.
          className={cn("docs-tab-panel pt-1", switched && "docs-panel-in")}
        >
          {panel}
        </div>
      ))}
    </div>
  );
}
