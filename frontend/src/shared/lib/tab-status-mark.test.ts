import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { markFavicon, markTitle, stripTitleMark } from "./tab-status-mark.ts";

describe("markTitle", () => {
  it("prefixes the title with the mark for the activity", () => {
    assert.equal(markTitle("Submit | Skynet", "busy"), "● Submit | Skynet");
    assert.equal(markTitle("Submit | Skynet", "idle"), "○ Submit | Skynet");
  });

  it("replaces an earlier mark instead of stacking them", () => {
    assert.equal(markTitle("○ Submit | Skynet", "busy"), "● Submit | Skynet");
    assert.equal(markTitle("● Submit | Skynet", null), "Submit | Skynet");
  });

  it("leaves a title without a mark alone", () => {
    assert.equal(stripTitleMark("Skynet"), "Skynet");
    assert.equal(markTitle("Skynet", null), "Skynet");
  });
});

describe("markFavicon", () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96"/></svg>';

  it("draws the dot inside the document and returns a data URL", () => {
    const url = markFavicon(svg, "busy");
    assert.ok(url.startsWith("data:image/svg+xml;utf8,"));
    const decoded = decodeURIComponent(url.slice("data:image/svg+xml;utf8,".length));
    assert.ok(decoded.endsWith('fill="#1a7a3a"/></svg>'));
    assert.ok(decoded.includes('<rect width="96" height="96"/><circle '));
  });

  it("uses a different fill per activity", () => {
    assert.notEqual(markFavicon(svg, "busy"), markFavicon(svg, "idle"));
  });

  it("refuses a document without a closing svg tag", () => {
    assert.throws(() => markFavicon("<svg>", "idle"), /not an SVG/);
  });
});
