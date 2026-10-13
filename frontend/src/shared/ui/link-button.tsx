"use client";

import type * as React from "react";
import Link from "next/link";
import { Button } from "@/shared/ui/primitives/button";

/**
 * A `Button`-styled `next/link`, safe to render from a Server Component.
 *
 * A Server Component must not write `<Button asChild><Link/></Button>` itself:
 * the client can receive the link as a lazy RSC reference, Radix `Slot` (which
 * only clones real elements) then renders nothing, and hydration of the whole
 * page fails. Building the link here keeps it a real element on both server
 * and client; only `children` (text, icons) cross the boundary.
 */
export function LinkButton({
  href,
  variant = "outline",
  size,
  className,
  "aria-label": ariaLabel,
  children,
}: {
  href: string;
  variant?: "default" | "outline" | "secondary" | "ghost" | "link";
  size?: "default" | "xs" | "sm" | "lg";
  className?: string;
  "aria-label"?: string;
  children: React.ReactNode;
}) {
  return (
    <Button asChild variant={variant} size={size} className={className}>
      <Link href={href} aria-label={ariaLabel}>
        {children}
      </Link>
    </Button>
  );
}
