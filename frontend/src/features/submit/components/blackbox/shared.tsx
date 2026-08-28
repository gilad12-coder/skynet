"use client";

import { useId, type ReactNode } from "react";
import { motion, useReducedMotion, type Transition } from "framer-motion";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/shared/ui/primitives/card";
import { Label } from "@/shared/ui/primitives/label";
import { cn } from "@/shared/lib/utils";

export const TEXTAREA_CLASS =
  "flex min-h-[44px] w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 lg:text-sm";

export const MOBILE_INPUT_CLASS = "min-h-[44px] text-base lg:min-h-0 lg:text-sm";

export const MOBILE_NUMBER_INPUT_CLASS =
  "h-[44px] [&_button]:size-[44px] [&_input]:text-base lg:h-9 lg:[&_button]:size-9 lg:[&_input]:text-sm";

export function StepCard({
  title,
  description,
  children,
  tutorial,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  tutorial?: string;
}) {
  return (
    <Card
      className="border-border/50 bg-card/80 backdrop-blur-xl shadow-lg"
      data-tutorial={tutorial}
    >
      <CardHeader className="px-4 sm:px-6">
        <CardTitle className="text-lg">{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="space-y-5 px-4 sm:px-6">{children}</CardContent>
    </Card>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  trailing,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  // Rendered at the end of the label row (status chips, version steppers).
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      {trailing ? (
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor={htmlFor}>{label}</Label>
          <div className="flex items-center gap-2">{trailing}</div>
        </div>
      ) : (
        <Label htmlFor={htmlFor}>{label}</Label>
      )}
      {children}
      {hint ? (
        <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

const SEGMENTED_TRANSITION: Transition = {
  type: "tween",
  duration: 0.2,
  ease: [0.22, 1, 0.36, 1],
};

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  desc?: string;
}

/** Pill toggle in the wizard's segmented style; grows to any option count. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<SegmentedOption<T>>;
}) {
  const pillId = useId();
  const prefersReducedMotion = useReducedMotion();
  return (
    <div
      className="grid w-full gap-1 rounded-lg bg-muted p-1"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      role="radiogroup"
    >
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(o.value)}
            className={cn(
              "relative min-h-[44px] cursor-pointer rounded-md px-2 py-2 text-center transition-colors duration-200 sm:px-3 lg:min-h-0",
              selected ? "text-foreground" : "text-foreground/60 hover:text-foreground",
            )}
          >
            {selected && (
              <motion.span
                layoutId={`segmented-pill-${pillId}`}
                className="absolute inset-0 rounded-md bg-background shadow-sm"
                transition={prefersReducedMotion ? { duration: 0 } : SEGMENTED_TRANSITION}
                aria-hidden="true"
              />
            )}
            <span className="relative z-10 block">
              <span className="text-sm font-medium">{o.label}</span>
              {o.desc ? (
                <span
                  className={cn(
                    "mt-0.5 block text-[0.6875rem] transition-colors duration-200",
                    selected ? "text-muted-foreground" : "text-foreground/40",
                  )}
                >
                  {o.desc}
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}
