/*
 * node --test cannot load .tsx, so this runs through jiti (OptimizerSourceLinks.render.test.ts
 * spawns it inside `npm run test:unit`). To run it by hand from frontend/:
 * JITI_JSX=1 JITI_ALIAS="{\"@/\":\"$PWD/src/\"}" npx jiti <this file>
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { setClientLocale } from "@/shared/lib/runtime-locale";
import { TooltipProvider } from "@/shared/ui/primitives/tooltip";
import { optimizerSources } from "../../lib/optimizer-sources";

// The classic JSX transform the test loader applies reads a global React.
(globalThis as { React?: typeof React }).React = React;
const { OptimizerSourceLinks } = await import("./OptimizerSourceLinks");

function render(id: Parameters<typeof optimizerSources>[0], name: string): string {
  setClientLocale("en");
  return renderToStaticMarkup(
    <TooltipProvider>
      <OptimizerSourceLinks optimizerName={name} sources={optimizerSources(id)} />
    </TooltipProvider>,
  );
}

type AnyElement = React.ReactElement<Record<string, unknown>>;

/** Every `<a>` element in a rendered element tree, without mounting it. */
function anchors(node: unknown): AnyElement[] {
  if (Array.isArray(node)) return node.flatMap(anchors);
  if (!React.isValidElement(node)) return [];
  const element = node as AnyElement;
  const own = element.type === "a" ? [element] : [];
  return [...own, ...anchors(element.props.children)];
}

void describe("OptimizerSourceLinks", () => {
  void it("opens the paper in a new tab without handing it the opener", () => {
    const html = render("gepa", "GEPA");
    assert.match(html, /<a [^>]*href="https:\/\/arxiv\.org\/abs\/2507\.19457"/);
    assert.match(html, /<a [^>]*target="_blank"/);
    assert.match(html, /<a [^>]*rel="noopener noreferrer"/);
  });

  void it("labels the list and each link for assistive technology", () => {
    const html = render("gepa", "GEPA");
    // The UI catalog does not load under jiti, so its strings render as their keys.
    assert.match(html, /<ul [^>]*aria-label="submit\.v2\.optimizer\.source\.list_aria"/);
    assert.match(html, /<a [^>]*aria-label="submit\.v2\.optimizer\.source\.paper_aria"/);
    assert.match(html, />submit\.v2\.optimizer\.source\.paper</);
  });

  void it("labels a repository as code, not as a paper", () => {
    const html = render("autoresearch", "AutoResearch");
    assert.match(html, /<a [^>]*href="https:\/\/github\.com\/karpathy\/autoresearch"/);
    assert.match(html, /<a [^>]*aria-label="submit\.v2\.optimizer\.source\.code_aria"/);
  });

  void it("renders nothing for an optimizer without a primary source", () => {
    assert.equal(render("best_of_n", "Best-of-N"), "");
    assert.equal(render("auto", "Auto"), "");
  });

  void it("keeps a link click and its keys from reaching the card's selection handlers", () => {
    setClientLocale("en");
    const tree = OptimizerSourceLinks({ optimizerName: "GEPA", sources: optimizerSources("gepa") });
    const links = anchors(tree);
    assert.equal(links.length, 1);
    const link = links[0]!;
    let stopped = 0;
    const event = { stopPropagation: () => void stopped++ };
    (link.props.onClick as (e: typeof event) => void)(event);
    (link.props.onKeyDown as (e: typeof event) => void)(event);
    assert.equal(stopped, 2);
  });
});
