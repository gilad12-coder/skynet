"use client";

import type { ComponentType, ReactNode } from "react";

import { Check } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import { TooltipButton } from "@/shared/ui/tooltip-button";
import { getActiveDir } from "@/shared/lib/runtime-locale";

/**
 * One slide of a picker carousel: a schematic banner, then the option's
 * identity (icon, label, tagline, description) and the check that commits it.
 *
 * Shared by the module picker and the recipe picker so the two read as the
 * same control rather than two lookalikes drifting apart.
 */
export function PickerSlide({
  Banner,
  icon: Icon,
  label,
  labelDir,
  tagline,
  description,
  chooseName,
  onChoose,
  selected,
}: {
  Banner: ComponentType;
  icon: ComponentType<{ className?: string }>;
  label: string;
  // Technical names (module classes) stay LTR in every locale; localized
  // labels follow the ambient direction.
  labelDir?: "ltr";
  tagline: string;
  description: string;
  // "Use <Option>": the tooltip and the accessible name of the commit button.
  chooseName: string;
  onChoose: () => void;
  // The slide is the option already in use — a clone link's recipe, or the one
  // the picker was reopened on — so its check renders filled.
  selected?: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border/50 bg-background/60 @3xl:flex @3xl:min-h-64 @3xl:items-stretch">
      <Banner />
      <div className="flex flex-col items-center justify-center gap-2 px-4 pb-6 pt-5 text-center sm:px-6 sm:pb-7 sm:pt-6 @3xl:flex-1 @3xl:px-10 @3xl:py-8">
        <div className="flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-lg bg-[#F3EDE3] text-[#3D2E22]">
            <Icon className="size-[1.125rem]" />
          </span>
          <h4 dir={labelDir} className="text-lg font-semibold tracking-tight text-foreground">
            {label}
          </h4>
        </div>
        <p className="text-sm font-medium text-[#5C4D40]">{tagline}</p>
        {/* The measure keeps the copy readable at full width; the floor is the
            longest description's three lines, so the card holds one height as
            slides change instead of shifting the nav under the cursor. */}
        <p className="min-h-[4rem] max-w-md text-[0.8125rem] leading-relaxed text-muted-foreground">
          {description}
        </p>
        <ChooseButton name={chooseName} selected={selected} onClick={onChoose} />
      </div>
    </div>
  );
}

/**
 * The slide's commit control: a check that picks the option it sits on.
 *
 * Icon-only, so the name carries as the tooltip and as the button's
 * accessible name — the same string in both, which is what keeps the hover
 * label and the screen-reader label from drifting apart.
 */
function ChooseButton({
  name,
  selected = false,
  onClick,
}: {
  name: string;
  selected?: boolean;
  onClick: () => void;
}) {
  return (
    <TooltipButton tooltip={name} side="top" dir={getActiveDir()}>
      <Button
        variant={selected ? "default" : "outline"}
        size="icon-lg"
        className="mt-2 size-[44px] rounded-full lg:size-10"
        aria-label={name}
        aria-pressed={selected}
        onClick={onClick}
      >
        <Check />
      </Button>
    </TooltipButton>
  );
}

/**
 * The banner shell every picker schematic is drawn into.
 *
 * The diagrams read input-to-output left-to-right in every locale, matching
 * the workflow canvas (which one of them depicts) rather than mirroring.
 */
export function BannerFrame({ children }: { children: ReactNode }) {
  return (
    // Sized only by container queries — mixing in a `sm:` height would leave
    // two utilities competing for `height` from different variant groups.
    <div className="relative h-36 shrink-0 border-b border-border/50 bg-gradient-to-br from-[#F3EDE3] via-[#FAF8F5] to-[#EDE7DD] @xl:h-44 @3xl:h-auto @3xl:w-[45%] @3xl:border-b-0 @3xl:border-e">
      {/* The dot grid is CSS rather than an SVG pattern so it covers the whole
          banner — the schematic letterboxes inside the viewBox, a pattern fill
          would letterbox with it and leave bare bands at the sides. */}
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          backgroundImage: "radial-gradient(circle, rgba(61,46,34,0.07) 1px, transparent 1px)",
          backgroundSize: "12px 12px",
        }}
      />
      <svg
        viewBox="0 0 240 88"
        preserveAspectRatio="xMidYMid meet"
        className="absolute inset-0 h-full w-full"
        aria-hidden="true"
      >
        {children}
      </svg>
    </div>
  );
}

export function GBox({
  x,
  y,
  w,
  h,
  accent = false,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  accent?: boolean;
}) {
  return (
    <rect
      x={x}
      y={y}
      width={w}
      height={h}
      rx={6}
      fill={accent ? "#C8A882" : "#FAF8F5"}
      fillOpacity={accent ? 0.45 : 0.9}
      stroke="#3D2E22"
      strokeOpacity={accent ? 0.4 : 0.22}
      strokeWidth={1.25}
    />
  );
}

export function GWire({ d }: { d: string }) {
  return (
    <path
      d={d}
      fill="none"
      stroke="#3D2E22"
      strokeOpacity={0.3}
      strokeWidth={1.25}
      strokeLinecap="round"
    />
  );
}

/** A bar standing in for a line of text or code inside a node. */
export function GBar({ x, y, w }: { x: number; y: number; w: number }) {
  return <rect x={x} y={y} width={w} height={2.5} rx={1.25} fill="#3D2E22" fillOpacity={0.3} />;
}

/** The arrowhead terminating a wire, tip at `(x, y)`. */
export function GArrow({ x, y, dir }: { x: number; y: number; dir: "up" | "down" | "right" }) {
  const points =
    dir === "up"
      ? `${x},${y} ${x - 2.5},${y + 4.5} ${x + 2.5},${y + 4.5}`
      : dir === "down"
        ? `${x},${y} ${x - 2.5},${y - 4.5} ${x + 2.5},${y - 4.5}`
        : `${x},${y} ${x - 4.5},${y - 2.5} ${x - 4.5},${y + 2.5}`;
  return <polygon points={points} fill="#3D2E22" fillOpacity={0.35} />;
}
