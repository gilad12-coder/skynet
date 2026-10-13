"use client";

import type { ReactNode } from "react";
import { cn } from "@/shared/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/primitives/card";

interface AnalyticsSectionProps {
  title: ReactNode;
  children: ReactNode;
  className?: string;
  /** Tighter padding and a smaller title, for a section inside a narrow panel. */
  compact?: boolean;
}

export function AnalyticsSection({ title, children, className, compact }: AnalyticsSectionProps) {
  return (
    <Card className={cn(compact && "gap-2 rounded-xl py-3", className)}>
      <CardHeader className={compact ? "px-4" : "pb-3"}>
        <CardTitle className={compact ? "text-sm" : "text-base"}>{title}</CardTitle>
      </CardHeader>
      <CardContent className={cn("pt-0", compact && "px-4")}>{children}</CardContent>
    </Card>
  );
}
