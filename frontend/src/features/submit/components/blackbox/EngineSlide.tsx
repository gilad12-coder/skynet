"use client";

import type { ComponentType } from "react";

import { ArrowsClockwise, Cube, GitBranch, Robot, Shuffle, Wrench } from "@/shared/ui/icons";
import { Badge } from "@/shared/ui/primitives/badge";
import { formatMsg, msg } from "@/shared/lib/messages";

import type { BlackboxEngineId, BlackboxEngineInfo } from "@/shared/types/api";
import { BannerFrame, ChooseButton, GArrow, GBar, GBox, GWire } from "../steps/PickerSlide";

/**
 * One slide of the engine carousel: the engine's schematic banner, its
 * identity and availability, and the check that picks it.
 *
 * Mirrors the module picker's slide so the two carousels in the wizard read
 * as one control; the extra availability row is the only difference.
 */
export function EngineSlide({
  engine,
  selected,
  blocked,
  onChoose,
}: {
  engine: BlackboxEngineInfo;
  selected: boolean;
  // The seed shape rules this engine out; the slide stays readable so the
  // user can see what they are giving up by keeping the seed as parts.
  blocked: boolean;
  onChoose: () => void;
}) {
  const { Banner, icon: Icon } = ENGINE_VISUALS[engine.id] ?? GENERIC_VISUAL;
  return (
    <div className="overflow-hidden rounded-xl border border-border/50 bg-background/60 @3xl:flex @3xl:min-h-64 @3xl:items-stretch">
      <Banner />
      <div className="flex flex-col items-center justify-center gap-2 px-4 pb-6 pt-5 text-center sm:px-6 sm:pb-7 sm:pt-6 @3xl:flex-1 @3xl:px-10 @3xl:py-8">
        <div className="flex flex-wrap items-center justify-center gap-2.5">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent text-muted-foreground [&_svg]:size-4">
            <Icon className="size-4" />
          </span>
          <h4 dir="ltr" className="text-lg font-semibold tracking-tight text-foreground">
            {engine.label}
          </h4>
          {!engine.available && (
            <Badge variant="secondary" size="sm">
              {msg("submit.blackbox.engines.not_runnable")}
            </Badge>
          )}
        </div>
        {/* The floor is the longest description's three lines, so the card
            holds one height as slides change instead of shifting the nav. */}
        <p className="min-h-[4rem] max-w-md text-[0.8125rem] leading-relaxed text-muted-foreground">
          {engine.description}
        </p>
        {blocked ? (
          <p className="max-w-md text-xs text-[var(--warning)]">
            {msg("submit.blackbox.validation.engine_parts")}
          </p>
        ) : (
          !engine.available &&
          engine.unavailable_reason && (
            <p className="max-w-md text-xs text-[var(--warning)]" dir="auto">
              {engine.unavailable_reason}
            </p>
          )
        )}
        <ChooseButton
          name={formatMsg("submit.blackbox.engines.choose", { p1: engine.label })}
          selected={selected}
          disabled={blocked}
          onClick={onChoose}
        />
      </div>
    </div>
  );
}

interface EngineVisual {
  Banner: ComponentType;
  icon: ComponentType<{ className?: string }>;
}

// Each banner is the engine's search loop in the wizard's schematic grammar:
// plain boxes are versions, the accented one is the proposer or the winner.

function GepaBanner() {
  return (
    <BannerFrame>
      <GBox x={22} y={33} w={34} h={22} />
      <GBar x={30} y={40} w={18} />
      <GBar x={30} y={46} w={12} />
      <GWire d="M56 44 H80 C92 44 92 22 104 22" />
      <GWire d="M56 44 H104" />
      <GWire d="M56 44 H80 C92 44 92 66 104 66" />
      <GBox x={104} y={11} w={34} h={22} />
      <GBar x={112} y={18} w={18} />
      <GBox x={104} y={33} w={34} h={22} />
      <GBar x={112} y={40} w={18} />
      <GBox x={104} y={55} w={34} h={22} />
      <GBar x={112} y={62} w={18} />
      <GWire d="M138 22 H162 C174 22 174 44 186 44" />
      <GWire d="M138 66 H162 C174 66 174 44 186 44" />
      <GArrow x={190} y={44} dir="right" />
      <GBox x={190} y={31} w={34} h={26} accent />
      <GBar x={198} y={39} w={18} />
      <GBar x={198} y={45} w={12} />
    </BannerFrame>
  );
}

function BestOfNBanner() {
  return (
    <BannerFrame>
      <GBox x={22} y={33} w={34} h={22} accent />
      <GBar x={30} y={40} w={18} />
      <GBar x={30} y={46} w={12} />
      <GWire d="M56 44 H76 C88 44 88 16 100 16" />
      <GWire d="M56 44 H76 C88 44 88 35 100 35" />
      <GWire d="M56 44 H76 C88 44 88 54 100 54" />
      <GWire d="M56 44 H76 C88 44 88 73 100 73" />
      <GBox x={100} y={8} w={34} h={16} />
      <GBar x={108} y={15} w={18} />
      <GBox x={100} y={27} w={34} h={16} />
      <GBar x={108} y={34} w={18} />
      <GBox x={100} y={46} w={34} h={16} />
      <GBar x={108} y={53} w={18} />
      <GBox x={100} y={65} w={34} h={16} />
      <GBar x={108} y={72} w={18} />
      <GWire d="M134 35 H164 C176 35 176 44 188 44" />
      <GArrow x={192} y={44} dir="right" />
      <GBox x={192} y={33} w={30} h={22} accent />
      <GBar x={199} y={40} w={16} />
      <GBar x={199} y={46} w={10} />
    </BannerFrame>
  );
}

function AutoResearchBanner() {
  return (
    <BannerFrame>
      <GBox x={30} y={30} w={56} h={28} accent />
      <GBar x={40} y={38} w={30} />
      <GBar x={40} y={44} w={22} />
      <GBar x={40} y={50} w={26} />
      <GWire d="M86 38 H150" />
      <GArrow x={154} y={38} dir="right" />
      <GBox x={154} y={30} w={56} h={28} />
      <GBar x={164} y={38} w={36} />
      <GBar x={164} y={44} w={24} />
      <GBar x={164} y={50} w={30} />
      <GWire d="M154 50 H90" />
      <GArrow x={86} y={50} dir="right" />
      <GWire d="M182 58 V72 H58 V62" />
      <GArrow x={58} y={58} dir="up" />
    </BannerFrame>
  );
}

function MetaHarnessBanner() {
  return (
    <BannerFrame>
      <GBox x={22} y={30} w={44} h={28} accent />
      <GBar x={30} y={38} w={26} />
      <GBar x={30} y={44} w={18} />
      <GBar x={30} y={50} w={22} />
      <GWire d="M66 44 H90 C102 44 102 22 114 22" />
      <GWire d="M66 44 H114" />
      <GWire d="M66 44 H90 C102 44 102 66 114 66" />
      <GBox x={114} y={13} w={30} h={18} />
      <GBar x={121} y={21} w={16} />
      <GBox x={114} y={35} w={30} h={18} />
      <GBar x={121} y={43} w={16} />
      <GBox x={114} y={57} w={30} h={18} />
      <GBar x={121} y={65} w={16} />
      <GWire d="M144 22 H166 C178 22 178 44 190 44" />
      <GWire d="M144 44 H190" />
      <GWire d="M144 66 H166 C178 66 178 44 190 44" />
      <GArrow x={194} y={44} dir="right" />
      <GBox x={194} y={33} w={28} h={22} />
      <GBar x={201} y={40} w={14} />
      <GBar x={201} y={46} w={10} />
      <GWire d="M208 55 V76 H44 V62" />
      <GArrow x={44} y={58} dir="up" />
    </BannerFrame>
  );
}

function AutoSaddlerBanner() {
  return (
    <BannerFrame>
      <GBox x={22} y={33} w={34} h={22} />
      <GBar x={30} y={40} w={18} />
      <GBar x={30} y={46} w={12} />
      <GWire d="M56 44 H76" />
      <GArrow x={80} y={44} dir="right" />
      <GBox x={80} y={29} w={44} h={30} accent />
      <GBar x={90} y={37} w={24} />
      <GBar x={90} y={43} w={18} />
      <GBar x={90} y={49} w={22} />
      <GWire d="M124 44 H144" />
      <GArrow x={148} y={44} dir="right" />
      <GBox x={148} y={33} w={34} h={22} />
      <GBar x={156} y={40} w={18} />
      <GBar x={156} y={46} w={12} />
      <GWire d="M182 44 H202" />
      <GArrow x={206} y={44} dir="right" />
      <GBox x={206} y={33} w={20} h={22} />
      <GBar x={211} y={40} w={10} />
      <GBar x={211} y={46} w={7} />
      <GWire d="M165 55 V72 H102 V63" />
      <GArrow x={102} y={59} dir="up" />
    </BannerFrame>
  );
}

function GenericBanner() {
  return (
    <BannerFrame>
      <GBox x={60} y={33} w={34} h={22} />
      <GBar x={68} y={40} w={18} />
      <GBar x={68} y={46} w={12} />
      <GWire d="M94 44 H140" />
      <GArrow x={144} y={44} dir="right" />
      <GBox x={144} y={31} w={36} h={26} accent />
      <GBar x={152} y={39} w={20} />
      <GBar x={152} y={45} w={14} />
    </BannerFrame>
  );
}

const GENERIC_VISUAL: EngineVisual = { Banner: GenericBanner, icon: Cube };

const ENGINE_VISUALS: Record<BlackboxEngineId, EngineVisual> = {
  gepa: { Banner: GepaBanner, icon: GitBranch },
  best_of_n: { Banner: BestOfNBanner, icon: Shuffle },
  autoresearch: { Banner: AutoResearchBanner, icon: Robot },
  meta_harness: { Banner: MetaHarnessBanner, icon: Wrench },
  autosaddler: { Banner: AutoSaddlerBanner, icon: ArrowsClockwise },
};
