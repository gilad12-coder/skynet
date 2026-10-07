"use client";

import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/primitives/card";

interface AnalyticsSectionProps {
  title: ReactNode;
  children: ReactNode;
  className?: string;
}

export function AnalyticsSection({ title, children, className }: AnalyticsSectionProps) {
  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">{children}</CardContent>
    </Card>
  );
}
