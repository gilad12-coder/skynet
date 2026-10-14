"use client";

import { useEffect, useState } from "react";
import { AnimatedWordmark } from "@/shared/ui/animated-wordmark";
import { EvolutionMorph } from "@/shared/ui/evolution-morph";

// 1.8 s in all: the morph lands on the human at 1.5 s, then a 0.3 s fade.
const MORPH_MS = 1500;
const FADE_MS = 300;

/**
 * App-load splash: the DRWN letters morphing at the centre of the screen, with
 * the evolution morph playing just above them,
 * held until the figure lands on the human and then faded out. Reduced motion
 * shows the still human and letters and skips the hold.
 */
export function SplashScreen() {
  const [phase, setPhase] = useState<"active" | "fading" | "done">("active");

  useEffect(() => {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const fadeDelay = reduceMotion ? 0 : MORPH_MS;
    const doneDelay = reduceMotion ? 0 : MORPH_MS + FADE_MS;
    const fadeTimer = setTimeout(() => setPhase("fading"), fadeDelay);
    const removeTimer = setTimeout(() => setPhase("done"), doneDelay);

    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(removeTimer);
    };
  }, []);

  if (phase === "done") return null;

  return (
    <div
      className="fixed inset-0 z-[99999] flex items-center justify-center bg-background"
      aria-hidden="true"
      style={{
        // Hidden figure lines are masked with this colour, so it must match the backdrop.
        ["--evolution-ground" as string]: "var(--background)",
        ...(phase === "fading"
          ? {
              opacity: 0,
              transition: `opacity ${FADE_MS}ms cubic-bezier(0.16, 1, 0.3, 1)`,
              pointerEvents: "none" as const,
            }
          : {}),
      }}
    >
      {/* The letters own the centre; the figure hangs above them so its changing
          silhouette never shifts the letters off centre. */}
      <div className="relative">
        <EvolutionMorph
          durationMs={MORPH_MS}
          width={300}
          className="absolute bottom-full left-1/2 mb-2 -translate-x-1/2 motion-reduce:hidden"
        />
        {/* The server can't know the motion preference, so the still human is
            swapped in by CSS; otherwise the fish shows until hydration. */}
        <EvolutionMorph
          still
          width={300}
          className="absolute bottom-full left-1/2 mb-2 hidden -translate-x-1/2 motion-reduce:block"
        />
        <AnimatedWordmark size={72} autoMorph morphSpeed={120} />
      </div>
    </div>
  );
}
