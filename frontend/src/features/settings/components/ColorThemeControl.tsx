"use client";

import { useId } from "react";

import { Moon, Sun } from "@/shared/ui/icons";
import { msg } from "@/shared/lib/messages";
import { cn } from "@/shared/lib/utils";
import { COLOR_THEMES, type ColorTheme } from "@/shared/lib/color-theme";
import { useColorTheme } from "@/shared/providers";

const THEME_KEYS = {
  system: "settings.account.theme.system",
  light: "settings.account.theme.light",
  dark: "settings.account.theme.dark",
} as const;

// Fixed colors, not tokens: each laptop shows its own theme whichever theme
// the app is in right now.
type Palette = {
  page: string;
  side: string;
  card: string;
  line: string;
  muted: string;
  text: string;
  brand: string;
  link: string;
  ok: string;
  bad: string;
};

const SCREENS: Record<"light" | "dark", Palette> = {
  light: {
    page: "#fcfaf7",
    side: "#f5f0ea",
    card: "#ffffff",
    line: "#e6ded4",
    muted: "#d8cdc0",
    text: "#3d342c",
    brand: "#b4521f",
    link: "#b4521f",
    ok: "#2f7565",
    bad: "#c4413a",
  },
  dark: {
    page: "#221d19",
    side: "#1c1814",
    card: "#2c2621",
    line: "#483d34",
    muted: "#54483d",
    text: "#e6dccf",
    brand: "#b4521f",
    link: "#e0935a",
    ok: "#6cc0a8",
    bad: "#ef8a6a",
  },
};

const SCREEN = { x: 10, y: 6, w: 100, h: 52 };

/** The dashboard in one theme: sidebar, stats card, pill tabs and the runs table. */
function Screen({ palette: p }: { palette: Palette }) {
  const { x, y, w, h } = SCREEN;
  const main = { x: x + 21, w: w - 25 };
  const panel = { fill: p.card, stroke: p.line, strokeWidth: 0.4 };
  const statW = main.w / 3;
  const rows = [
    { name: 0.34, status: p.ok },
    { name: 0.26, status: p.link },
    { name: 0.3, status: p.bad },
  ];
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} fill={p.page} />
      <rect x={x} y={y} width={17} height={h} fill={p.side} />
      <rect x={x + 17} y={y} width={0.4} height={h} fill={p.line} />
      <rect x={x + 3} y={y + 3.5} width={9} height={1.8} rx={0.9} fill={p.link} />
      <rect x={x + 3} y={y + 8} width={11} height={3.2} rx={1.6} fill={p.brand} />
      {[14.5, 18.5, 22.5, 26.5].map((dy, i) => (
        <rect
          key={dy}
          x={x + 3}
          y={y + dy}
          width={i === 0 ? 10 : 11 - i * 1.5}
          height={1.3}
          rx={0.65}
          fill={i === 0 ? p.text : p.muted}
          opacity={i === 0 ? 0.55 : 1}
        />
      ))}
      <rect x={x + 3} y={y + h - 4.5} width={11} height={1} rx={0.5} fill={p.muted} />
      <rect x={x + 3} y={y + h - 4.5} width={4.5} height={1} rx={0.5} fill={p.link} />

      <rect x={main.x} y={y + 4} width={main.w} height={12} rx={1.6} {...panel} />
      {[0, 1, 2].map((i) => {
        const sx = main.x + i * statW;
        return (
          <g key={i}>
            {i > 0 && <rect x={sx} y={y + 6.5} width={0.4} height={7} fill={p.line} />}
            <circle cx={sx + 3.2} cy={y + 7.6} r={0.7} fill={[p.brand, p.ok, p.bad][i]} />
            <rect x={sx + 4.6} y={y + 7.1} width={statW * 0.4} height={1} rx={0.5} fill={p.muted} />
            <rect
              x={sx + 2.5}
              y={y + 10.2}
              width={statW * (0.42 - i * 0.08)}
              height={2.8}
              rx={0.8}
              fill={p.text}
              opacity={0.85}
            />
          </g>
        );
      })}

      <rect x={main.x} y={y + 19.5} width={21} height={4} rx={2} fill={p.side} />
      <rect x={main.x + 0.5} y={y + 20} width={10} height={3} rx={1.5} fill={p.brand} />
      <rect x={main.x + 13} y={y + 21} width={6} height={1} rx={0.5} fill={p.muted} />

      <rect x={main.x} y={y + 26} width={main.w} height={h - 29} rx={1.6} {...panel} />
      {[0.04, 0.5, 0.78].map((f, i) => (
        <rect
          key={f}
          x={main.x + main.w * f + 2}
          y={y + 28.6}
          width={i === 0 ? 8 : 6}
          height={0.9}
          rx={0.45}
          fill={p.muted}
        />
      ))}
      <rect x={main.x} y={y + 31} width={main.w} height={0.4} fill={p.line} />
      {rows.map((row, i) => {
        const ry = y + 33.8 + i * 6.2;
        return (
          <g key={i}>
            {i > 0 && (
              <rect x={main.x + 2} y={ry - 2.4} width={main.w - 4} height={0.3} fill={p.line} />
            )}
            <rect
              x={main.x + main.w * 0.04 + 2}
              y={ry}
              width={main.w * row.name}
              height={1.4}
              rx={0.7}
              fill={p.text}
              opacity={0.7}
            />
            <rect
              x={main.x + main.w * 0.5 + 2}
              y={ry - 0.6}
              width={9}
              height={2.6}
              rx={1.3}
              fill={row.status}
              opacity={0.16}
            />
            <circle cx={main.x + main.w * 0.5 + 3.8} cy={ry + 0.7} r={0.6} fill={row.status} />
            <rect
              x={main.x + main.w * 0.5 + 5}
              y={ry + 0.2}
              width={4.5}
              height={1}
              rx={0.5}
              fill={row.status}
            />
            <rect
              x={main.x + main.w * 0.78 + 2}
              y={ry + 0.1}
              width={7}
              height={1.2}
              rx={0.6}
              fill={p.muted}
            />
          </g>
        );
      })}
    </g>
  );
}

/** A small laptop whose screen shows the dashboard in the given theme. */
function Laptop({ theme }: { theme: ColorTheme }) {
  const id = useId();
  const screenClip = `${id}-screen`;
  const darkClip = `${id}-dark`;
  const { x, y, w, h } = SCREEN;
  return (
    <svg viewBox="0 0 120 72" className="h-auto w-full" aria-hidden="true">
      <defs>
        <clipPath id={screenClip}>
          <rect x={x} y={y} width={w} height={h} rx={2} />
        </clipPath>
        {/* System shows the same dashboard: light on the left half, dark on the right. */}
        <clipPath id={darkClip}>
          <rect x={x + w / 2} y={y} width={w / 2} height={h} />
        </clipPath>
      </defs>
      <rect x={6} y={2} width={108} height={60} rx={5} fill="#2b2b2d" />
      <rect
        x={6.5}
        y={2.5}
        width={107}
        height={59}
        rx={4.6}
        fill="none"
        stroke="#48484b"
        strokeWidth={0.6}
      />
      <g clipPath={`url(#${screenClip})`}>
        <Screen palette={SCREENS[theme === "dark" ? "dark" : "light"]} />
        {theme === "system" && (
          <g clipPath={`url(#${darkClip})`}>
            <Screen palette={SCREENS.dark} />
          </g>
        )}
      </g>
      <circle cx={60} cy={4} r={0.7} fill="#48484b" />
      <path d="M0 64h120l-4 6H4z" fill="#b9babd" />
      <path d="M4 70h112l-.6.9H4.6z" fill="#9c9da0" />
      <rect x={50} y={64} width={20} height={2} rx={1} fill="#9c9da0" />
    </svg>
  );
}

/** Settings' theme picker: one laptop per theme, picked by clicking it; kept per browser. */
export function ColorThemeControl() {
  const { theme, resolved, setTheme } = useColorTheme();
  const HeaderIcon = resolved === "dark" ? Moon : Sun;
  const name = useId();

  return (
    <div className="flex items-start gap-3 border-b border-border/40 py-3">
      <HeaderIcon className="size-4 mt-0.5 text-muted-foreground shrink-0" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <span id={`${name}-label`} className="text-sm font-medium text-foreground">
            {msg("settings.account.theme.title")}
          </span>
          <span className="text-xs text-muted-foreground/80">
            {msg("settings.account.theme.subtitle")}
          </span>
        </div>
        <div
          role="radiogroup"
          aria-labelledby={`${name}-label`}
          className="mx-auto grid w-full max-w-md grid-cols-3 gap-2 sm:gap-3"
        >
          {COLOR_THEMES.map((value) => {
            const selected = theme === value;
            return (
              <label
                key={value}
                className={cn(
                  "group flex cursor-pointer flex-col items-center gap-1.5 rounded-lg border p-2 transition-colors",
                  "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50",
                  selected
                    ? "border-primary bg-primary/5"
                    : "border-border/60 hover:border-border hover:bg-muted/40",
                )}
              >
                <input
                  type="radio"
                  name={name}
                  value={value}
                  checked={selected}
                  onChange={() => setTheme(value)}
                  className="sr-only"
                />
                <Laptop theme={value} />
                <span
                  className={cn(
                    "text-xs",
                    selected
                      ? "font-medium text-primary"
                      : "text-muted-foreground group-hover:text-foreground",
                  )}
                >
                  {msg(THEME_KEYS[value])}
                </span>
              </label>
            );
          })}
        </div>
      </div>
    </div>
  );
}
