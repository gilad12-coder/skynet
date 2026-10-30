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
import { TooltipContent, TooltipProvider } from "@/shared/ui/primitives/tooltip";
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

/** Every element of one type in a rendered element tree, without mounting it. */
function find(node: unknown, type: unknown): AnyElement[] {
  if (Array.isArray(node)) return node.flatMap((child) => find(child, type));
  if (!React.isValidElement(node)) return [];
  const element = node as AnyElement;
  const own = element.type === type ? [element] : [];
  return [...own, ...find(element.props.children, type)];
}

function anchors(node: unknown): AnyElement[] {
  return find(node, "a");
}

/** The plain text inside an element tree. */
function text(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (!React.isValidElement(node)) return "";
  return text((node as AnyElement).props.children);
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
  });

  void it("shows only an icon in the link, with no visible text", () => {
    const html = render("gepa", "GEPA");
    const link = /<a [^>]*>([\s\S]*?)<\/a>/.exec(html)?.[1] ?? "";
    assert.match(link, /^<svg[\s\S]*<\/svg>$/);
    assert.equal(link.replace(/<[^>]*>/g, "").trim(), "");
  });

  void it("puts the source title in the link's tooltip", () => {
    setClientLocale("en");
    const tree = OptimizerSourceLinks({ optimizerName: "GEPA", sources: optimizerSources("gepa") });
    const tips = find(tree, TooltipContent);
    assert.equal(tips.length, 1);
    assert.equal(text(tips[0]), "GEPA: Reflective Prompt Evolution Can Outperform Reinforcement Learning");
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
