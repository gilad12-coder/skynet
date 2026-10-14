"use client";

import { useEffect, useState } from "react";
import { AnimatedWordmark } from "@/shared/ui/animated-wordmark";
import { EvolutionMorph } from "@/shared/ui/evolution-morph";

// 1.5 s in all: the morph lands on the human at 1.2 s, then a 0.3 s fade.
const MORPH_MS = 1200;
const FADE_MS = 300;

/**
 * App-load splash: the evolution morph with the DRWN letters morphing below it,
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
      className="fixed inset-0 z-[99999] flex flex-col items-center justify-center gap-6 bg-background"
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
      <EvolutionMorph durationMs={MORPH_MS} />
      <AnimatedWordmark size={40} autoMorph morphSpeed={120} />
    </div>
  );
}
