"use client";

import * as React from "react";

import { msg } from "@/shared/lib/messages";
import { cn } from "@/shared/lib/utils";

import { EXPERIENCE_LEVELS, type ExperienceLevel } from "../lib/abstraction";
import { LEVEL_KEYS } from "./level-keys";

/**
 * The abstraction level as a stepped slider: one track, one stop per level,
 * the fill showing how much of Skynet is on screen. Each stop is a radio so
 * screen readers announce a choice of three, and the arrow keys follow the
 * reading direction so the slider moves the way it looks in Hebrew too.
 */
export function LevelSlider({
  value,
  onChange,
  label,
  disabled = false,
}: {
  value: ExperienceLevel;
  onChange: (level: ExperienceLevel) => void;
  label: string;
  disabled?: boolean;
}) {
  const stops = React.useRef<Array<HTMLButtonElement | null>>([]);
  const index = EXPERIENCE_LEVELS.indexOf(value);
  const last = EXPERIENCE_LEVELS.length - 1;
  const percent = (index / last) * 100;

  const select = (next: number, focus: boolean) => {
    const clamped = Math.min(last, Math.max(0, next));
    const level = EXPERIENCE_LEVELS[clamped];
    if (level && level !== value) onChange(level);
    if (focus) stops.current[clamped]?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    const step: Record<string, number> = {
      ArrowUp: 1,
      ArrowDown: -1,
      ArrowRight: rtl ? -1 : 1,
      ArrowLeft: rtl ? 1 : -1,
    };
    if (event.key === "Home") select(0, true);
    else if (event.key === "End") select(last, true);
    else if (event.key in step) select(index + (step[event.key] ?? 0), true);
    else return;
    event.preventDefault();
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      className={cn("flex flex-col gap-1.5", disabled && "opacity-50")}
    >
      <div className="relative mx-[22px] h-11">
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-input" />
        <div
          className="absolute start-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-primary transition-[width] duration-200 ease-out motion-reduce:transition-none"
          style={{ width: `${percent}%` }}
        />
        {EXPERIENCE_LEVELS.map((level, i) => {
          const selected = i === index;
          return (
            <button
              key={level}
              ref={(el) => {
                stops.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={msg(LEVEL_KEYS[level].label)}
              tabIndex={selected ? 0 : -1}
              disabled={disabled}
              onClick={() => select(i, false)}
              onKeyDown={onKeyDown}
              className="group absolute top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-full focus-visible:outline-none disabled:cursor-not-allowed"
              style={{ insetInlineStart: `calc(${(i / last) * 100}% - 22px)` }}
            >
              <span
                className={cn(
                  "block rounded-full transition-[width,height,box-shadow] duration-200 ease-out motion-reduce:transition-none",
                  "group-focus-visible:ring-2 group-focus-visible:ring-[#C8A882]/45 group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-background",
                  selected
                    ? "size-4 bg-primary shadow-sm"
                    : i < index
                      ? "size-2.5 bg-primary"
                      : "size-2.5 bg-muted-foreground/40 group-hover:bg-muted-foreground/70",
                )}
              />
            </button>
          );
        })}
      </div>
      <div className="grid grid-cols-3 gap-2" aria-hidden="true">
        {EXPERIENCE_LEVELS.map((level, i) => (
          <button
            key={level}
            type="button"
            tabIndex={-1}
            disabled={disabled}
            onClick={() => select(i, false)}
            className={cn(
              "flex min-w-0 flex-col gap-0.5 disabled:cursor-not-allowed",
              i === 0
                ? "items-start text-start"
                : i === last
                  ? "items-end text-end"
                  : "items-center text-center",
            )}
          >
            <span
              className={cn(
                "text-xs",
                i === index ? "font-semibold text-foreground" : "text-muted-foreground",
              )}
            >
              {msg(LEVEL_KEYS[level].label)}
            </span>
            <span className="text-[11px] leading-tight text-muted-foreground/80">
              {msg(LEVEL_KEYS[level].short)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
