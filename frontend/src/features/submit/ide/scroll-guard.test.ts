import assert from "node:assert/strict";
import { test } from "node:test";

import { clipsButScrolls, guardClippingInside } from "./scroll-guard.ts";

test("hidden overflow on either axis is a clipping scroll container", () => {
  assert.equal(clipsButScrolls({ overflowX: "hidden", overflowY: "hidden" }), true);
  assert.equal(clipsButScrolls({ overflowX: "visible", overflowY: "hidden" }), true);
  assert.equal(clipsButScrolls({ overflowX: "hidden", overflowY: "auto" }), true);
});

test("clip, visible and user-scrollable boxes are left alone", () => {
  assert.equal(clipsButScrolls({ overflowX: "clip", overflowY: "clip" }), false);
  assert.equal(clipsButScrolls({ overflowX: "visible", overflowY: "visible" }), false);
  assert.equal(clipsButScrolls({ overflowX: "auto", overflowY: "auto" }), false);
});

class FakeBox {
  scrollTop = 0;
  scrollLeft = 0;
  readonly ownerDocument: { activeElement: FakeBox | null };
  readonly overflow: string;
  readonly children: FakeBox[];
  constructor(doc: { activeElement: FakeBox | null }, overflow: string, children: FakeBox[] = []) {
    this.ownerDocument = doc;
    this.overflow = overflow;
    this.children = children;
  }
  contains(node: FakeBox): boolean {
    return node === this || this.children.some((c) => c.contains(node));
  }
}

function withFakeDom(run: () => void): void {
  const g = globalThis as Record<string, unknown>;
  const saved = { HTMLElement: g.HTMLElement, getComputedStyle: g.getComputedStyle };
  g.HTMLElement = FakeBox;
  g.getComputedStyle = (box: FakeBox) => ({ overflowX: box.overflow, overflowY: box.overflow });
  try {
    run();
  } finally {
    g.HTMLElement = saved.HTMLElement;
    g.getComputedStyle = saved.getComputedStyle;
  }
}

function hostWith(doc: { activeElement: FakeBox | null }, ...children: FakeBox[]) {
  const listeners: Array<(e: Event) => void> = [];
  const host = Object.assign(new FakeBox(doc, "visible", children), {
    addEventListener: (_: string, fn: (e: Event) => void) => listeners.push(fn),
    removeEventListener: (_: string, fn: (e: Event) => void) => listeners.splice(listeners.indexOf(fn), 1),
  });
  const scroll = (box: FakeBox) => {
    for (const fn of [...listeners]) fn({ target: box } as unknown as Event);
  };
  return { host: host as unknown as HTMLElement, scroll, listeners };
}

test("a clipping box that holds the focus is pinned back to 0", () => {
  withFakeDom(() => {
    const doc = { activeElement: null as FakeBox | null };
    const input = new FakeBox(doc, "hidden");
    const frame = new FakeBox(doc, "hidden", [input]);
    doc.activeElement = input;
    const { host, scroll, listeners } = hostWith(doc, frame);
    const release = guardClippingInside(host);
    frame.scrollLeft = 271;
    frame.scrollTop = 4;
    scroll(frame);
    assert.deepEqual([frame.scrollLeft, frame.scrollTop], [0, 0]);
    release();
    assert.equal(listeners.length, 0);
  });
});

test("the focused node, unfocused boxes and scrollable boxes keep their offsets", () => {
  withFakeDom(() => {
    const doc = { activeElement: null as FakeBox | null };
    const textarea = new FakeBox(doc, "hidden");
    const scroller = new FakeBox(doc, "auto", [textarea]);
    const other = new FakeBox(doc, "hidden");
    doc.activeElement = textarea;
    const { host, scroll } = hostWith(doc, scroller, other);
    guardClippingInside(host);
    for (const box of [textarea, scroller, other]) {
      box.scrollLeft = 40;
      scroll(box);
      assert.equal(box.scrollLeft, 40);
    }
  });
});
