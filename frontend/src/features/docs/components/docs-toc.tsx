"use client";

import * as React from "react";
import { cn } from "@/shared/lib/utils";

interface TocHeading {
  depth: 2 | 3;
  text: string;
  id: string;
}

/** The "On this page" list. It marks the section at the top of the screen. */
export function DocsToc({ headings, title }: { headings: TocHeading[]; title: string }) {
  const [current, setCurrent] = React.useState<string | null>(headings[0]?.id ?? null);

  React.useEffect(() => {
    const elements = headings
      .map((h) => document.getElementById(h.id))
      .filter((el): el is HTMLElement => el !== null);
    if (!elements.length) return;
    const update = () => {
      // The last heading above a line near the top of the screen is current.
      let id = elements[0]?.id ?? null;
      for (const el of elements) {
        if (el.getBoundingClientRect().top <= 120) id = el.id;
        else break;
      }
      setCurrent(id);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, [headings]);

  if (!headings.length) return null;
  return (
    <nav aria-label={title} className="text-sm">
      <p className="mb-3 font-medium text-foreground">{title}</p>
      <ul className="space-y-2 border-s border-border">
        {headings.map((h) => (
          <li key={h.id}>
            <a
              href={`#${h.id}`}
              aria-current={current === h.id ? "location" : undefined}
              className={cn(
                "-ms-px block border-s-2 py-0.5 leading-snug transition-colors",
                h.depth === 3 ? "ps-6" : "ps-3",
                current === h.id
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {h.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
