"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { HOATZIN_LOCKUP_VIEWBOX, HoatzinShapes } from "@/shared/ui/skynet-mark";

/**
 * Animated "DRWN" wordmark with morphing SVG letters.
 *
 * Each letter is a <g> with 4 variant sub-groups (default, glyph, serif, sans).
 * On hover a rapid interval (250ms) randomly picks 2-3 letters each tick and
 * switches each to a random variant via opacity. On mouse leave everything
 * resets to the default variant.
 */

type RectDef = { x: number; y: number; w: number; h: number };

type LetterVariants = {
  /** The standard base logo variant (bold, chunky, geometric) */
  default: string;
  /** The geometric square block representation */
  glyph: RectDef[];
  /** High-contrast Serif-style alternate */
  serif: string;
  /** Thinner / lighter uniform sans-serif alternate */
  sans: string;
};

type LetterDef = {
  offset: number;
  variants: LetterVariants;
};

// All letters are scaled within a 92-unit high viewBox, caps from y=2.1 to y=90.
// The D and R counters are drawn counter-clockwise against their clockwise outer
// contours, so the default nonzero fill punches them out while the overlapping
// strokes elsewhere still merge.

const LETTERS: LetterDef[] = [
  {
    offset: 0,
    variants: {
      default:
        "M 0 2.1 H 36 A 36 43.95 0 0 1 36 90 H 0 Z M 22 24.1 V 68 H 36 A 14 21.95 0 0 0 36 24.1 Z",
      glyph: [
        { x: 0, y: 2.1, w: 22.6, h: 22.6 },
        { x: 47, y: 35, w: 22.6, h: 22.6 },
        { x: 0, y: 68, w: 22.6, h: 22.6 },
      ],
      serif:
        "M 4 2.1 H 36 A 38 43.95 0 0 1 36 90 H 4 V 86.2 H 10 V 5.9 H 4 Z M 20 5.9 V 86.2 H 36 A 24 40.15 0 0 0 36 5.9 Z",
      sans: "M 2 2.1 H 34 A 36 43.95 0 0 1 34 90 H 2 Z M 13 12.3 V 79.8 H 34 A 25 33.75 0 0 0 34 12.3 Z",
    },
  },
  {
    offset: 82,
    variants: {
      default:
        "M 0 2.1 H 40 A 30 27.95 0 0 1 40 58 H 22 V 90 H 0 Z M 22 22.1 V 38 H 40 A 10 7.95 0 0 0 40 22.1 Z M 30 50 H 52 L 72 90 H 50 Z",
      glyph: [
        { x: 0, y: 35, w: 22.6, h: 22.6 },
        { x: 44, y: 2.1, w: 22.6, h: 22.6 },
        { x: 48, y: 68, w: 22.6, h: 22.6 },
      ],
      serif:
        "M 4 2.1 H 38 A 28 25.95 0 0 1 38 54 H 20 V 86.2 H 26 V 90 H 4 V 86.2 H 10 V 5.9 H 4 Z M 20 5.9 V 50.2 H 38 A 15 22.15 0 0 0 38 5.9 Z M 30 50.2 H 42 L 66 86.2 H 72 V 90 H 54 V 86.2 H 58 Z",
      sans: "M 2 2.1 H 38 A 28 25 0 0 1 38 52.1 H 13 V 90 H 2 Z M 13 12.3 V 41.9 H 38 A 17 14.8 0 0 0 38 12.3 Z M 36 48 H 49 L 68 90 H 55 Z",
    },
  },
  {
    offset: 164,
    variants: {
      default:
        "M 0 2.1 H 22 L 33.76 47 L 45 2.1 H 67 L 78.24 47 L 90 2.1 H 112 L 89 90 H 67 L 56 46.05 L 45 90 H 23 Z",
      glyph: [
        { x: 0, y: 2.1, w: 22.6, h: 22.6 },
        { x: 44.7, y: 68, w: 22.6, h: 22.6 },
        { x: 89.4, y: 2.1, w: 22.6, h: 22.6 },
      ],
      serif:
        "M 6 2.1 H 18 L 38 90 H 30 Z M 34 90 L 54 2.1 H 58 L 38 90 Z M 52 2.1 H 64 L 84 90 H 76 Z M 80 90 L 100 2.1 H 104 L 84 90 Z M 0 2.1 H 24 V 5.9 H 0 Z M 48 2.1 H 68 V 5.9 H 48 Z M 96 2.1 H 110 V 5.9 H 96 Z",
      sans: "M 2 2.1 H 13.5 L 31.75 68.9 L 50 2.1 H 61.5 L 79.75 68.9 L 98 2.1 H 109.5 L 85.5 90 H 74 L 55.75 23.16 L 37.5 90 H 26 Z",
    },
  },
  {
    offset: 284,
    variants: {
      default:
        "M 0 2.1 h 22 v 87.9 h -22 Z M 52 2.1 h 22 v 87.9 h -22 Z M 0 2.1 l 74 87.9 h -22 l -52 -87.9 Z",
      glyph: [
        { x: 0, y: 68, w: 22.6, h: 22.6 },
        { x: 25, y: 35, w: 22.6, h: 22.6 },
        { x: 50, y: 2.1, w: 22.6, h: 22.6 },
      ],
      serif:
        "M 8 2.1 h 18 v 3.8 h -5 v 78.3 h 5 v 3.8 h -18 v -3.8 h 5 v -78.3 h -5 Z M 56 2.1 h 18 v 3.8 h -5 v 78.3 h 5 v 3.8 h -18 v -3.8 h 5 v -78.3 h -5 Z M 13 2.1 H 25 L 69 90 H 57 Z",
      sans: "M 2 2.1 h 11 v 87.9 h -11 Z M 52 2.1 h 11 v 87.9 h -11 Z M 2 2.1 l 61 87.9 h -11 l -50 -87.9 Z",
    },
  },
];

const TOTAL_WIDTH = 360;

// The hoatzin brand mark (shared/ui/skynet-mark.tsx) leads the letters, taller than them:
// the cropped neck ends on the baseline (y=90), the eye sits on the letters' centre line
// (y=46) and the crest rises above the cap height. It stays still while the letters morph.
const MARK_TOP = -30;
const MARK_HEIGHT = 120;
const MARK_WIDTH = 111;
const MARK_GAP = 22;
const MARK_SHIFT = MARK_WIDTH + MARK_GAP;
const VARIANT_NAMES = ["default", "glyph", "serif", "sans"] as const;
type VariantName = (typeof VARIANT_NAMES)[number];

function pickRandom(total: number, count: number): number[] {
  const indices: number[] = [];
  const pool = Array.from({ length: total }, (_, i) => i);
  for (let i = 0; i < Math.min(count, total); i++) {
    const r = Math.floor(Math.random() * pool.length);
    indices.push(pool[r]!);
    pool.splice(r, 1);
  }
  return indices;
}

function randomOtherVariant(current: VariantName): VariantName {
  const others = VARIANT_NAMES.filter((v) => v !== current);
  return others[Math.floor(Math.random() * others.length)]!;
}

// Only the outgoing variant fades. When both sides of a swap faded, ticks faster
// than the fade (120-250 ms) left letters fully blank for hundreds of ms.
const FADE_OUT = "opacity 300ms cubic-bezier(0.215, 0.610, 0.355, 1.000)";

function VariantGroup({
  variant,
  letter,
  active,
}: {
  variant: VariantName;
  letter: LetterDef;
  active: boolean;
}) {
  const content = letter.variants;
  const style = active ? { opacity: 1, transition: "none" } : { opacity: 0, transition: FADE_OUT };

  if (variant === "glyph") {
    return (
      <g style={style}>
        {content.glyph.map((r, i) => (
          <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} />
        ))}
      </g>
    );
  }

  const d =
    variant === "default" ? content.default : variant === "serif" ? content.serif : content.sans;

  return <path d={d} style={style} />;
}

export function AnimatedWordmark({
  size = 28,
  className,
  autoMorph = false,
  autoMorphDuration,
  morphSpeed = 250,
  fluid = false,
  withMark = false,
}: {
  size?: number;
  className?: string;
  /** Morph continuously from mount, independent of hover (for splash/idle states) */
  autoMorph?: boolean;
  /** When set (ms), an auto-morphing wordmark settles back to its default
   *  variant after this many ms instead of morphing forever — for persistent
   *  surfaces (navbar, landing) where perpetual motion gets distracting.
   *  Ignored unless `autoMorph` is on. */
  autoMorphDuration?: number;
  /** Interval in ms between morph ticks (default 250) */
  morphSpeed?: number;
  /** Fill the parent's width (height derives from the viewBox) instead of using `size`. */
  fluid?: boolean;
  /** Lead with the hoatzin brand mark, drawn at the letters' height. */
  withMark?: boolean;
}) {
  const totalWidth = withMark ? TOTAL_WIDTH + MARK_SHIFT : TOTAL_WIDTH;
  const [activeVariants, setActiveVariants] = useState<VariantName[]>(() =>
    LETTERS.map(() => "default"),
  );
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reducedMotionRef = useRef(false);
  // True while autoMorph owns the animation; a timed autoMorph hands control
  // back to hover once it settles.
  const autoActiveRef = useRef(false);

  useEffect(() => {
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotionRef.current = mql.matches;
    const handler = (e: MediaQueryListEvent) => {
      reducedMotionRef.current = e.matches;
    };
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  const startMorph = useCallback(() => {
    if (intervalRef.current) return;

    intervalRef.current = setInterval(() => {
      const count = 2 + Math.floor(Math.random() * 2); // Picks 2 or 3 letters to change
      const indices = pickRandom(LETTERS.length, count);

      setActiveVariants((prev) => {
        const next = [...prev];
        for (const idx of indices) {
          next[idx] = randomOtherVariant(prev[idx] ?? "default");
        }
        return next;
      });
    }, morphSpeed);
  }, [morphSpeed]);

  const stopMorph = useCallback(() => {
    if (intervalRef.current != null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setActiveVariants(LETTERS.map(() => "default"));
  }, []);

  const handleMouseEnter = useCallback(() => {
    // While autoMorph owns the lifecycle the wordmark is already morphing — hover
    // must not spin up a second interval.
    if (autoActiveRef.current) return;
    if (!reducedMotionRef.current) startMorph();
  }, [startMorph]);

  const handleMouseLeave = useCallback(() => {
    // Never reset a continuously-morphing wordmark on leave; it should keep
    // morphing regardless of hover.
    if (autoActiveRef.current) return;
    stopMorph();
  }, [stopMorph]);

  useEffect(() => {
    if (autoMorph && !reducedMotionRef.current) {
      // Clear any stale ref before starting to avoid the guard in startMorph
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      autoActiveRef.current = true;
      startMorph();
      if (autoMorphDuration != null) {
        stopTimeoutRef.current = setTimeout(() => {
          autoActiveRef.current = false;
          stopMorph();
        }, autoMorphDuration);
      }
    }
    return () => {
      autoActiveRef.current = false;
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (stopTimeoutRef.current) {
        clearTimeout(stopTimeoutRef.current);
        stopTimeoutRef.current = null;
      }
    };
  }, [autoMorph, autoMorphDuration, startMorph, stopMorph]);

  // `size` stays the letters' height; with the mark the box grows upward to hold the crest.
  const top = withMark ? MARK_TOP : 0;
  const boxHeight = 92 - top;
  const svgHeight = (size * boxHeight) / 92;
  const svgWidth = (svgHeight * totalWidth) / boxHeight;

  return (
    <span
      dir="ltr"
      className={`${fluid ? "flex w-full justify-center" : "inline-flex"} items-center text-primary select-none cursor-default ${className ?? ""}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      role="img"
      aria-label="DRWN"
    >
      <svg
        className="overflow-visible transition-all duration-300 pointer-events-none"
        width={fluid ? undefined : svgWidth}
        height={fluid ? undefined : svgHeight}
        viewBox={`0 ${top} ${totalWidth} ${boxHeight}`}
        fill="currentColor"
        stroke="none"
        xmlns="http://www.w3.org/2000/svg"
        style={fluid ? { width: "100%", height: "auto", color: "var(--foreground)" } : { color: "var(--foreground)" }}
      >
        {withMark && (
          <svg y={MARK_TOP} width={MARK_WIDTH} height={MARK_HEIGHT} viewBox={HOATZIN_LOCKUP_VIEWBOX}>
            {/* Fluid lockups fill a wide column; fixed ones are header-sized, where the
                full line work would blur together. */}
            <HoatzinShapes detail={fluid || svgHeight >= 64 ? "full" : "simple"} />
          </svg>
        )}
        {LETTERS.map((letter, li) => (
          <g key={li} transform={`translate(${letter.offset + (withMark ? MARK_SHIFT : 0)}, 0)`}>
            {VARIANT_NAMES.map((name) => (
              <VariantGroup
                key={name}
                variant={name}
                letter={letter}
                active={activeVariants[li] === name}
              />
            ))}
          </g>
        ))}
      </svg>
    </span>
  );
}
