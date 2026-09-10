import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { markFavicon } from "./tab-status-mark.ts";

describe("markFavicon", () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96"/></svg>';

  it("draws the dot over the logo and returns a data URL", () => {
    const url = markFavicon(svg, "busy");
    assert.ok(url.startsWith("data:image/svg+xml;utf8,"));
    const decoded = decodeURIComponent(url.slice("data:image/svg+xml;utf8,".length));
    assert.ok(decoded.endsWith('fill="#1a7a3a"/></svg>'));
    assert.ok(decoded.includes('<rect width="96" height="96"/><circle '));
  });

  it("fills the dot green while busy and gray while idle", () => {
    const decoded = (activity: "busy" | "idle") =>
      decodeURIComponent(markFavicon(svg, activity).slice("data:image/svg+xml;utf8,".length));
    assert.ok(decoded("busy").includes('fill="#1a7a3a"'));
    assert.ok(decoded("idle").includes('fill="#9a948d"'));
  });

  it("refuses a document without a closing svg tag", () => {
    assert.throws(() => markFavicon("<svg>", "idle"), /not an SVG/);
  });
});
