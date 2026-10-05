"use client";

import * as React from "react";

import { foldTier, glideKey, pairByText } from "@/shared/lib/table-glide";

const GLIDE_MS = 320;
const GLIDE_EASE = "cubic-bezier(0.23, 1, 0.32, 1)";
// Measuring every row on every resize frame is too slow for long tables.
// Rows outside this window are off screen, so skipping them is invisible.
const MAX_ROWS = 80;

type Box = { x: number; y: number; w: number; h: number };

function visibleBox(el: Element, origin: DOMRect): Box | null {
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height };
}

/** Rows plus the pieces inside them whose position can change on a fold. */
function glidePieces(table: HTMLTableElement, viewport: DOMRect) {
  const rows: HTMLTableRowElement[] = [];
  for (const row of table.rows) {
    const r = row.getBoundingClientRect();
    if (r.bottom < viewport.top - r.height || r.top > viewport.bottom + r.height) continue;
    rows.push(row);
    if (rows.length >= MAX_ROWS) break;
  }
  return rows.map((row) => ({
    row,
    pieces: [
      ...row.querySelectorAll<HTMLElement>(':scope > td, :scope > th, [data-slot="table-inline"]'),
    ],
  }));
}

type Snapshot = Map<Element, Box | null>;

function snapshot(table: HTMLTableElement): Snapshot {
  const origin = table.getBoundingClientRect();
  const viewport = new DOMRect(0, 0, window.innerWidth, window.innerHeight);
  const snap: Snapshot = new Map();
  for (const { row, pieces } of glidePieces(table, viewport)) {
    const rowBox = visibleBox(row, origin);
    snap.set(row, rowBox);
    for (const piece of pieces) {
      const box = visibleBox(piece, origin);
      // Pieces are stored relative to their row, so a row that moves and a
      // cell that moves inside it are not counted twice.
      snap.set(piece, box && rowBox ? { ...box, x: box.x - rowBox.x, y: box.y - rowBox.y } : null);
    }
  }
  return snap;
}

function inlineEnd(el: Element): string {
  return getComputedStyle(el).direction === "rtl" ? "left center" : "right center";
}

/**
 * FLIP-animate a table when its container crosses a fold point: rows and
 * cells glide from their old spot to the new one, a folding value travels
 * into its row's primary cell (and back out when the table widens), and a
 * value with no counterpart scales in from its inline end.
 */
export function useTableGlide(
  containerRef: React.RefObject<HTMLDivElement | null>,
  tableRef: React.RefObject<HTMLTableElement | null>,
) {
  React.useEffect(() => {
    const container = containerRef.current;
    const table = tableRef.current;
    if (!container || !table || typeof ResizeObserver === "undefined") return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

    let last: Snapshot = new Map();
    let tier = -1;
    let frame = 0;
    const running = new Set<Animation>();

    const folds = () => table.querySelector("[data-collapse]") !== null;
    const remPx = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const refresh = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        last = folds() ? snapshot(table) : new Map();
      });
    };

    const play = (el: Element, keyframes: Keyframe[], origin?: string) => {
      if (origin) (el as HTMLElement).style.transformOrigin = origin;
      const anim = el.animate(keyframes, { duration: GLIDE_MS, easing: GLIDE_EASE });
      running.add(anim);
      const done = () => {
        running.delete(anim);
        if (origin) (el as HTMLElement).style.transformOrigin = "";
        if (running.size === 0) delete container.dataset.gliding;
      };
      anim.onfinish = done;
      anim.oncancel = done;
    };

    const glide = (before: Snapshot) => {
      for (const anim of [...running]) anim.cancel();
      const after = snapshot(table);
      container.dataset.gliding = "";

      const appeared: Element[] = [];
      const departed: Element[] = [];
      for (const [el, box] of after) {
        const old = before.get(el);
        if (box && old === null) appeared.push(el);
      }
      for (const [el, old] of before) {
        if (old && after.get(el) === null) departed.push(el);
      }
      const pairs = pairByText(appeared, departed, (el) => glideKey(el.textContent));

      for (const [el, box] of after) {
        if (!box) continue;
        const old = before.get(el);
        const from = old ?? (pairs.has(el) ? before.get(pairs.get(el)!) : undefined);
        if (from) {
          const dx = from.x - box.x;
          const dy = from.y - box.y;
          if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
          play(el, [
            { transform: `translate(${dx}px, ${dy}px)`, opacity: old ? 1 : 0.4 },
            { transform: "translate(0, 0)", opacity: 1 },
          ]);
        } else if (old === null) {
          play(
            el,
            [
              { transform: "scale(0.9)", opacity: 0 },
              { transform: "scale(1)", opacity: 1 },
            ],
            inlineEnd(el),
          );
        }
      }
      last = after;
      if (running.size === 0) delete container.dataset.gliding;
    };

    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentBoxSize?.[0]?.inlineSize ?? container.clientWidth;
      const next = foldTier(width, remPx());
      const crossed = tier !== -1 && next !== tier;
      tier = next;
      if (crossed && !reduced.matches && folds() && last.size > 0) {
        cancelAnimationFrame(frame);
        glide(last);
      } else {
        refresh();
      }
    });
    observer.observe(container);

    // Rows added, removed or re-sorted would otherwise glide from where they
    // were before the data changed, not from where they were last drawn.
    const mutations = new MutationObserver(refresh);
    mutations.observe(table, { childList: true, subtree: true, characterData: true });

    return () => {
      observer.disconnect();
      mutations.disconnect();
      cancelAnimationFrame(frame);
      for (const anim of [...running]) anim.cancel();
    };
  }, [containerRef, tableRef]);
}
