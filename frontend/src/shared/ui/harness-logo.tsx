"use client";

import * as React from "react";
import { ClaudeCode, Codex, OpenCode } from "@lobehub/icons";
import type { BlackboxHarness } from "@/shared/types/api";

/**
 * Brand mark for an agent harness, in the same colored-tile style as
 * `ProviderLogo`. Pi has no mark in @lobehub/icons, so it gets a drawn π tile;
 * a harness without a mark (custom) renders nothing. `dir="ltr"` keeps the
 * mark upright under RTL.
 */
export function HarnessLogo({ harness, size = 20 }: { harness: BlackboxHarness; size?: number }) {
  const mark = renderMark(harness, size);
  if (!mark) return null;
  return (
    <span dir="ltr" className="inline-flex shrink-0">
      {mark}
    </span>
  );
}

// Select triggers and items resize and tint every bare <svg> below them; an
// inline size plus a `text-*` class opts the brand glyph out of both rules.
const GLYPH_CLASS = "text-inherit";

function renderMark(harness: BlackboxHarness, size: number): React.ReactNode {
  const glyphStyle = { width: size, height: size };
  switch (harness) {
    case "pi":
      return <PiMark size={size} />;
    case "codex":
      // @lobehub/icons ships Codex's avatar as white-on-white; the brand tile is a white mark on black.
      return (
        <Codex.Avatar
          size={size}
          background="#000"
          color="#fff"
          iconClassName={GLYPH_CLASS}
          iconStyle={glyphStyle}
        />
      );
    case "claude_code":
      return <ClaudeCode.Avatar size={size} iconClassName={GLYPH_CLASS} iconStyle={glyphStyle} />;
    case "opencode":
      return <OpenCode.Avatar size={size} iconClassName={GLYPH_CLASS} iconStyle={glyphStyle} />;
    default:
      return null;
  }
}

function PiMark({ size }: { size: number }) {
  return (
    <span
      role="img"
      aria-label="Pi"
      className="inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground"
      style={{ width: size, height: size }}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={GLYPH_CLASS}
        style={{ width: size * 0.62, height: size * 0.62 }}
        aria-hidden="true"
      >
        <path d="M4.5 7.5h15" />
        <path d="M9 7.5c0 4.2-.7 7.6-2.4 10.5" />
        <path d="M15.5 7.5v8.6c0 1.3.8 2 1.9 2 .7 0 1.3-.3 1.8-.8" />
      </svg>
    </span>
  );
}
