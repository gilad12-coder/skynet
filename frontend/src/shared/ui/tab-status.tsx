"use client";

import * as React from "react";

import { useResolvedTabActivity } from "@/shared/hooks/use-tab-activity";
import type { TabActivity } from "@/shared/lib/tab-activity";
import { markFavicon, markTitle } from "@/shared/lib/tab-status-mark";

const ICON_SELECTOR = 'link[rel~="icon"]';

let faviconSource: Promise<string | null> | null = null;

/** The favicon's SVG text, fetched once from the link the page shipped with. */
function loadFaviconSource(href: string): Promise<string | null> {
  faviconSource ??= fetch(href)
    .then((response) => (response.ok ? response.text() : null))
    .catch(() => null);
  return faviconSource;
}

/**
 * Keeps the browser tab's favicon and title in step with the app's activity.
 * Mounted once at the root; renders nothing.
 */
export function TabStatus() {
  const activity = useResolvedTabActivity();
  const baseHref = React.useRef<string | null>(null);

  React.useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>(ICON_SELECTOR);
    if (link && baseHref.current === null) baseHref.current = link.getAttribute("href");
    const original = baseHref.current;
    let cancelled = false;
    let marked: string | null = null;

    const applyTitle = () => {
      const next = markTitle(document.title, activity);
      if (next !== document.title) document.title = next;
    };
    const applyIcon = () => {
      const icon = document.querySelector<HTMLLinkElement>(ICON_SELECTOR);
      if (!icon) return;
      const href = marked ?? original;
      if (href !== null && icon.getAttribute("href") !== href) icon.setAttribute("href", href);
    };

    applyTitle();
    if (activity === null) {
      applyIcon();
      return;
    }
    if (original) {
      void loadFaviconSource(original).then((svg) => {
        if (cancelled || !svg) return;
        marked = markFavicon(svg, activity as TabActivity);
        applyIcon();
      });
    }

    // Navigation rewrites <title> from route metadata and may swap the icon
    // link; put the mark back whenever the head changes. Attributes are not
    // observed, so our own writes never re-trigger this.
    const observer = new MutationObserver(() => {
      applyTitle();
      applyIcon();
    });
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });

    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [activity]);

  return null;
}
