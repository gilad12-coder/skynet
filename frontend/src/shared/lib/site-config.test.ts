/** Contract: the public site URL falls back to the domain the project owns. */

import assert from "node:assert/strict";
import test from "node:test";

import { getSiteUrl } from "./site-config.ts";

function withSiteUrl(value: string | undefined, run: () => void): void {
  const previous = process.env.NEXT_PUBLIC_SITE_URL;
  if (value === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
  else process.env.NEXT_PUBLIC_SITE_URL = value;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = previous;
  }
}

test("unset NEXT_PUBLIC_SITE_URL falls back to https://skynetml.com", () => {
  withSiteUrl(undefined, () => {
    assert.equal(getSiteUrl(), "https://skynetml.com");
  });
});

// The Dockerfile copies an unset build arg into ENV, which yields "" rather
// than undefined; "" would make `new URL(siteUrl)` in the root layout throw.
test("empty NEXT_PUBLIC_SITE_URL falls back to https://skynetml.com", () => {
  withSiteUrl("", () => {
    assert.equal(getSiteUrl(), "https://skynetml.com");
  });
});

test("a set NEXT_PUBLIC_SITE_URL wins over the fallback", () => {
  withSiteUrl("https://staging.skynetml.com", () => {
    assert.equal(getSiteUrl(), "https://staging.skynetml.com");
  });
});

test("the fallback never names the unowned skynet.app domain", () => {
  withSiteUrl(undefined, () => {
    assert.doesNotMatch(new URL(getSiteUrl()).hostname, /(^|\.)skynet\.app$/);
  });
});
