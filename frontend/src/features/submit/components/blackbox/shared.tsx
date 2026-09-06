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
import { HelpTip } from "@/shared/ui/help-tip";
import { cn } from "@/shared/lib/utils";
import { getActiveDir } from "@/shared/lib/runtime-locale";
import { radioNavigationIndex } from "../../lib/radio-navigation";
import { tip as tipText, type TooltipKey } from "@/shared/lib/tooltips";

export const TEXTAREA_CLASS =
  "flex min-h-[44px] w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 lg:text-sm";

export const MOBILE_INPUT_CLASS = "min-h-[44px] text-base lg:min-h-0 lg:text-sm";

export const MOBILE_NUMBER_INPUT_CLASS =
  "h-[44px] [&_button]:size-[44px] [&_input]:text-base lg:h-9 lg:[&_button]:size-9 lg:[&_input]:text-sm";

export function StepCard({
  title,
  description,
  tip,
  trailing,
  children,
  tutorial,
}: {
  title: ReactNode;
  description?: ReactNode;
  // Guidance that used to sit in the body; hovering the title shows it.
  tip?: string;
  // Rendered at the end of the title row (mode toggles, status chips).
  trailing?: ReactNode;
  children: ReactNode;
  tutorial?: string;
}) {
  const heading = (
    <CardTitle className="text-lg">{tip ? <HelpTip text={tip}>{title}</HelpTip> : title}</CardTitle>
  );
  return (
    <Card
      className="border-border/50 bg-card/80 backdrop-blur-xl shadow-lg"
      data-tutorial={tutorial}
    >
      <CardHeader className="px-4 sm:px-6">
        {trailing ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            {heading}
            {trailing}
          </div>
        ) : (
          heading
        )}
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      {/* Positioned so an expanded textarea covers the fields, not the page. */}
      <CardContent className="relative space-y-5 px-4 sm:px-6">{children}</CardContent>
    </Card>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  tip,
  trailing,
  className,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  // Extra guidance; it joins the label tooltip rather than taking a line
  // under the control.
  hint?: string;
  // Tooltip catalog key; hovering the label explains what the field controls.
  tip?: TooltipKey;
  // Rendered at the end of the label row (status chips, version steppers).
  trailing?: ReactNode;
  // Root classes, e.g. to let the field fill a flex column.
  className?: string;
  children: ReactNode;
}) {
  const help = [tip ? tipText(tip) : null, hint].filter(Boolean).join(" ");
  const labelNode = help ? <HelpTip text={help}>{label}</HelpTip> : label;
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {trailing ? (
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor={htmlFor}>{labelNode}</Label>
          <div className="flex items-center gap-2">{trailing}</div>
        </div>
      ) : (
        <Label htmlFor={htmlFor}>{labelNode}</Label>
      )}
      {children}
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
  compact = false,
  label,
}: {
  value: T;
  label: string;
  onChange: (v: T) => void;
  options: Array<SegmentedOption<T>>;
  // Sized to sit inside a label row instead of spanning the field.
  compact?: boolean;
}) {
  const pillId = useId();
  const prefersReducedMotion = useReducedMotion();
  return (
    <div
      className={cn(
        "grid rounded-lg bg-muted",
        compact ? "w-auto gap-0.5 p-0.5" : "w-full gap-1 p-1",
      )}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      role="radiogroup"
      aria-label={label}
    >
      {options.map((o, index) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onKeyDown={(event) => {
              const next = radioNavigationIndex(
                event.key,
                index,
                options.length,
                getActiveDir() === "rtl",
              );
              if (next === null) return;
              event.preventDefault();
              const option = options[next];
              if (!option) return;
              onChange(option.value);
              event.currentTarget.parentElement
                ?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
                [next]?.focus();
            }}
            onClick={() => onChange(o.value)}
            className={cn(
              "relative cursor-pointer rounded-md text-center transition-colors duration-200 lg:min-h-0",
              compact ? "min-h-[36px] px-2.5 py-0.5" : "min-h-[44px] px-2 py-2 sm:px-3",
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
              <span className={cn("font-medium", compact ? "text-xs" : "text-sm")}>{o.label}</span>
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

/** Collapse/expand a block with the grid-rows transition the split card uses. */
export function cnGrid(open: boolean): string {
  return cn(
    "grid transition-[grid-template-rows,opacity] duration-200 ease-out",
    open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
  );
}
