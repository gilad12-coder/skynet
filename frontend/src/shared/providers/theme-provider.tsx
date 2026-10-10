"use client";

import * as React from "react";
import { DirectionProvider } from "@radix-ui/react-direction";
import { MotionConfig } from "framer-motion";
import { dirForLocale } from "@/shared/lib/locale";
import { useLocale } from "@/shared/providers/locale-provider";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const { locale } = useLocale();
  return (
    <DirectionProvider dir={dirForLocale(locale)}>
      {/* framer-motion defaults to "never"; "user" honours the OS reduced-motion setting. */}
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </DirectionProvider>
  );
}
