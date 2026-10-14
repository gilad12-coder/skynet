"use client";

import { useEffect, useState } from "react";
import { EVOLUTION_DURATION_MS, EvolutionMorph } from "@/shared/ui/evolution-morph";

const FADE_MS = 300;

/**
 * App-load splash: the evolution morph alone, centred, held until it lands on
 * the human and then faded out. Reduced motion shows the still human and skips
 * the hold.
 */
export function SplashScreen() {
  const [phase, setPhase] = useState<"active" | "fading" | "done">("active");

  useEffect(() => {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const fadeDelay = reduceMotion ? 0 : EVOLUTION_DURATION_MS;
    const doneDelay = reduceMotion ? 0 : EVOLUTION_DURATION_MS + FADE_MS;
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
      <EvolutionMorph />
    </div>
  );
}
